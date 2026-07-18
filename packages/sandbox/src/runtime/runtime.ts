import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS, collectCloudflareErrorMessages } from '../internal/shared/cloudflare-retry'
import {
  createResourceRuntime,
  type ProviderPort,
  type ResourceRuntimeContext,
} from '../internal/shared/resource-runtime'
import { sleep } from '../internal/shared/utils'
import { SandboxError } from '../sandbox/errors'
import { isSandboxAbort } from '../sandbox/provider-call'
import { detectSandbox, isSandboxAvailable } from '../sandbox/providers/shared'
import { validateSandboxConfig } from '../sandbox/validation'
import { safeUseRequest } from '../internal/shared/runtime'
import { executeSandboxDefinition } from './execute'
import { readSandboxErrorMetadata, toSandboxError } from './error-normalization'
import { loadSandboxProviderRuntime } from './provider-loader-resolver'
import {
  assertSandboxDefinitionOptions,
  createCloudflareExecutionSandboxId,
  resolveRuntimeProvider,
  resolveSandboxProvider,
  withSandboxProvider,
  type SandboxEvent,
} from './provider-resolution'
import { err, ok } from './result'
import { getSandboxRuntimeConfig, getSandboxRuntimeRegistry, type SandboxRegistryEntry } from './state'

import type {
  AgentSandboxConfig,
  SandboxDefinitionOptions,
  SandboxExecutionOptions,
  SandboxRunResult,
} from '../module-types'
import { getSandboxFeatureProvider } from '../module-types'
import type { SandboxClient, SandboxProviderOptions } from '../sandbox/types'

type SandboxRuntimeContext = ResourceRuntimeContext<AgentSandboxConfig, SandboxRegistryEntry, SandboxEvent>
const sandboxRegistry = {}

function isRetriableCloudflareSandboxError(error: unknown) {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const metadata = readSandboxErrorMetadata(error)

  const provider = sandboxError?.details?.provider || metadata?.provider
  if (provider && provider !== 'cloudflare') return false

  const extraMessage = metadata?.cause instanceof Error ? metadata.cause.message : ''
  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(collectCloudflareErrorMessages(error, extraMessage))
}

export async function createSandboxWithConfig(
  config: AgentSandboxConfig,
  local: SandboxDefinitionOptions = {},
  context: { event?: SandboxEvent } = {},
) {
  assertSandboxDefinitionOptions(local)
  const event = context.event ?? safeUseRequest<SandboxEvent>()
  const resolvedProviderConfig = getSandboxFeatureProvider(config)
  const provider = resolveRuntimeProvider(resolvedProviderConfig, event)
  const { createSandboxClient, resolvedProvider } = await resolveSandboxProvider(
    provider,
    withSandboxProvider(provider, resolvedProviderConfig),
    local,
    { event },
  )

  const validation = validateSandboxConfig(resolvedProvider as SandboxProviderOptions)
  if (!validation.ok) {
    const firstIssue =
      validation.issues.find((issue) => issue.severity === 'error') || validation.issues[0]
    throw new SandboxError({
      code: 'SANDBOX_VALIDATION_ERROR',
      details: { provider },
      message: firstIssue?.message || `[${provider}] invalid sandbox config`,
    })
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
    const runtimeProvider = await loadSandboxProviderRuntime(provider.provider)

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
            if (isSandboxAbort(error))
              throw error
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

        throw new SandboxError({
          code: 'SANDBOX_RUNTIME_ERROR',
          details: { provider: provider.provider },
          message: 'Cloudflare sandbox retries exhausted.',
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
    if (isSandboxAbort(error))
      throw error
    return err(toSandboxError(error))
  }
}

export {
  detectSandbox,
  isSandboxAvailable,
  resolveRuntimeProvider,
}
