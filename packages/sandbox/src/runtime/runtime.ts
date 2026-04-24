import { createHash, randomUUID } from 'node:crypto'
import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS } from '../internal/shared/cloudflare-retry'
import { getCloudflareEnv } from '../internal/shared/provider-detection'
import {
  createResourceRuntime,
  type ProviderPort,
  type ResourceRuntimeContext,
} from '../internal/shared/resource-runtime'
import type {
  AgentSandboxConfig,
  SandboxDefinitionOptions,
  SandboxDefinitionProviderOptions,
  SandboxExecutionOptions,
  SandboxRunResult,
} from '../module-types'
import { getSandboxFeatureProvider } from '../module-types'
import { SandboxError } from '../sandbox/errors'
import { detectSandbox, isSandboxAvailable } from '../sandbox/providers/shared'
import type { SandboxClient, SandboxProvider, SandboxProviderOptions } from '../sandbox/types'
import { loadSandboxRuntimeProvider } from 'virtual:vitehub-sandbox-provider-loader'
import { validateSandboxConfig } from '../sandbox/validation'
import { executeSandboxDefinition } from './execute'
import { err, ok } from './result'
import { getSandboxRuntimeConfig, getSandboxRuntimeRegistry, type SandboxRegistryEntry } from './state'
import sandboxRegistry from 'virtual:vitehub-sandbox-registry'

type SandboxEvent = {
  context?: {
    cloudflare?: { env?: Record<string, unknown> }
    _platform?: { cloudflare?: { env?: Record<string, unknown> } }
  }
}

type SandboxRuntimeContext = ResourceRuntimeContext<AgentSandboxConfig, SandboxRegistryEntry, SandboxEvent>

function readSandboxErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object')
    return undefined

  const metadata = error as {
    code?: unknown
    provider?: unknown
    cause?: unknown
    details?: unknown
  }

  return {
    code: typeof metadata.code === 'string' ? metadata.code : undefined,
    provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
    cause: metadata.cause,
    details: typeof metadata.details === 'object' && metadata.details !== null
      ? metadata.details as Record<string, unknown>
      : undefined,
  }
}

function toSandboxError(error: unknown) {
  if (error instanceof SandboxError)
    return error

  const metadata = readSandboxErrorMetadata(error)
  if (error instanceof Error) {
    return new SandboxError(error.message, {
      code: metadata?.code || 'SANDBOX_RUNTIME_ERROR',
      provider: metadata?.provider,
      details: metadata?.details,
      cause: metadata?.cause ?? error,
    })
  }

  return new SandboxError(String(error), {
    code: metadata?.code || 'SANDBOX_RUNTIME_ERROR',
    provider: metadata?.provider,
    details: metadata?.details,
    cause: metadata?.cause ?? error,
  })
}

function isRetriableCloudflareSandboxError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const metadata = readSandboxErrorMetadata(error)
  const messages = [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    sandboxError?.cause instanceof Error ? sandboxError.cause.message : '',
    metadata?.cause instanceof Error ? metadata.cause.message : '',
  ].filter(Boolean).join('\n')

  const provider = sandboxError?.provider || metadata?.provider
  if (provider && provider !== 'cloudflare')
    return false

  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(messages)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createCloudflareExecutionSandboxId(name: string, sandboxId?: string) {
  if (sandboxId)
    return sandboxId

  const hash = createHash('sha256')
    .update(`${name}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)

  return `vitehub-${name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}-${hash}`
}

export function resolveRuntimeProvider(provider?: SandboxDefinitionProviderOptions, event?: SandboxEvent) {
  if (provider?.provider)
    return provider.provider

  const envProvider = typeof process !== 'undefined' ? process.env?.SANDBOX_PROVIDER : undefined
  if (envProvider === 'cloudflare' || envProvider === 'vercel')
    return envProvider

  if (getCloudflareEnv(event))
    return 'cloudflare'

  const detected = detectSandbox()
  if (detected.type === 'cloudflare' || detected.type === 'vercel')
    return detected.type

  throw new SandboxError('Sandbox provider could not be inferred. Configure `sandbox.provider` as `cloudflare` or `vercel`.', {
    code: 'SANDBOX_PROVIDER_REQUIRED',
  })
}

const allowedDefinitionKeys = new Set(['timeout', 'env', 'runtime'])

function assertSandboxDefinitionOptions(local: SandboxDefinitionOptions) {
  const invalidKeys = Object.keys(local).filter(key => !allowedDefinitionKeys.has(key))
  if (invalidKeys.length > 0)
    throw new TypeError(`[vitehub] Sandbox definition options only support timeout, env, runtime. Unsupported: ${invalidKeys.join(', ')}`)
}

async function resolveSandboxProvider(
  provider: SandboxProvider,
  providerOptions: SandboxDefinitionProviderOptions & { provider: SandboxProvider },
  local: SandboxDefinitionOptions,
  context: { event?: SandboxEvent },
) {
  const runtimeProvider = await loadSandboxRuntimeProvider(provider)
  const resolvedProvider = await runtimeProvider.resolveSandboxProvider({
    local,
    provider: providerOptions,
  }, context) as SandboxProviderOptions

  return {
    createSandboxClient: runtimeProvider.createSandboxClient,
    resolvedProvider,
  }
}

function withSandboxProvider(
  provider: SandboxProvider,
  options?: SandboxDefinitionProviderOptions,
) {
  return {
    ...options,
    provider,
  } as SandboxDefinitionProviderOptions & { provider: SandboxProvider }
}

export async function createSandboxWithConfig(
  config: AgentSandboxConfig,
  local: SandboxDefinitionOptions = {},
  context: { event?: SandboxEvent } = {},
) {
  assertSandboxDefinitionOptions(local)
  const resolvedProviderConfig = getSandboxFeatureProvider(config)
  const provider = resolveRuntimeProvider(resolvedProviderConfig, context.event)
  const { createSandboxClient, resolvedProvider } = await resolveSandboxProvider(
    provider,
    withSandboxProvider(provider, resolvedProviderConfig),
    local,
    context,
  )

  const validation = validateSandboxConfig(resolvedProvider as SandboxProviderOptions)
  if (!validation.ok) {
    const firstIssue = validation.issues.find(issue => issue.severity === 'error') || validation.issues[0]
    throw new SandboxError(firstIssue?.message || `[${provider}] invalid sandbox config`)
  }

  return await createSandboxClient(resolvedProvider as SandboxProviderOptions)
}

type SandboxRunner = {
  name: string
  run: <TPayload = unknown, TResult = unknown>(
    payload?: TPayload,
    options?: SandboxExecutionOptions,
  ) => Promise<TResult>
}

const sandboxPort: ProviderPort<SandboxProviderOptions, SandboxRunner, SandboxRuntimeContext> = {
  async resolve(context) {
    const config = getSandboxFeatureProvider(context.config)
    const provider = resolveRuntimeProvider(config, context.event)

    return (await resolveSandboxProvider(
      provider,
      withSandboxProvider(provider, config),
      context.definition.options ?? {},
      { event: context.event },
    )).resolvedProvider
  },
  async create(provider, context) {
    const runtimeProvider = await loadSandboxRuntimeProvider(provider.provider)

    return {
      name: context.name,
      async run(payload, options = {}) {
        const cloudflareSandboxId = provider.provider === 'cloudflare'
          ? createCloudflareExecutionSandboxId(context.name, options.sandboxId || provider.sandboxId)
          : undefined
        const attempts = provider.provider === 'cloudflare'
          ? CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1
          : 1

        for (let attempt = 0; attempt < attempts; attempt++) {
          let sandbox: SandboxClient | undefined

          try {
            const createdSandbox = await runtimeProvider.createSandboxClient(
              cloudflareSandboxId
                ? {
                    ...provider,
                    sandboxId: cloudflareSandboxId,
                  } as SandboxProviderOptions
                : provider as SandboxProviderOptions,
            )
            sandbox = createdSandbox
            return await executeSandboxDefinition(
              createdSandbox,
              context.name,
              context.definition.options,
              context.definition.bundle,
              payload,
              options.context,
            )
          }
          catch (error) {
            const sandboxError = toSandboxError(error)
            const shouldRetry = provider.provider === 'cloudflare'
              && attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
              && isRetriableCloudflareSandboxError(sandboxError)

            if (!shouldRetry)
              throw sandboxError

            await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
          }
          finally {
            await sandbox?.stop().catch(() => {})
          }
        }

        throw new SandboxError('Cloudflare sandbox retries exhausted.', {
          code: 'SANDBOX_RUNTIME_ERROR',
          provider: provider.provider,
        })
      },
    }
  },
}

const sandboxRuntime = createResourceRuntime({
  feature: 'sandbox',
  readConfig(runtimeConfig) {
    return runtimeConfig.sandbox as false | AgentSandboxConfig | undefined
  },
  getFallbackConfig: getSandboxRuntimeConfig,
  registry: {
    entries: new Proxy(sandboxRegistry as Record<string, SandboxRegistryEntry | (() => Promise<{ default?: SandboxRegistryEntry }>)>, {
      get(target, property) {
        if (typeof property !== 'string')
          return Reflect.get(target, property)
        return getSandboxRuntimeRegistry()?.[property] ?? target[property]
      },
    }),
    validate(definition) {
      return !!definition.bundle
        && typeof definition.bundle === 'object'
        && typeof definition.bundle.entry === 'string'
        && definition.bundle.entry.length > 0
        && !!definition.bundle.modules
        && typeof definition.bundle.modules === 'object'
        && Object.keys(definition.bundle.modules).length > 0
    },
  },
  port: sandboxPort,
})

export async function resolveSandboxRunner<TPayload = unknown, TResult = unknown>(name?: string) {
  return await sandboxRuntime.get(name) as SandboxRunner & {
    run: (payload?: TPayload, options?: SandboxExecutionOptions) => Promise<TResult>
  }
}

export async function runSandboxRuntime<TPayload = unknown, TResult = unknown>(
  name?: string,
  payload?: TPayload,
  options?: SandboxExecutionOptions,
): Promise<SandboxRunResult<TResult>> {
  try {
    const sandbox = await resolveSandboxRunner<TPayload, TResult>(name)
    return ok(await sandbox.run(payload, options))
  }
  catch (error) {
    return err(toSandboxError(error))
  }
}

export {
  detectSandbox,
  isSandboxAvailable,
}
