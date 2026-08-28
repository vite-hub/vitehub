import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS, collectCloudflareErrorMessages } from '../internal/shared/cloudflare-retry'
import {
  createResourceRuntime,
  type ProviderPort,
  type ResourceRuntimeContext,
} from '../internal/shared/resource-runtime'
import { sleep } from '../internal/shared/utils'
import { sandboxError } from '../sandbox/errors'
import { executeSandboxDefinition } from './execute'
import { readSandboxErrorMetadata, toSandboxError } from './error-normalization'
import { createSandboxExecutionBox, type SandboxExecutionBox } from './execution-box'
import type { ResolvedSandboxBox } from './provider-loader'
import {
  assertSandboxDefinitionOptions,
  createCloudflareExecutionSandboxId,
  detectSandbox,
  isSandboxAvailable,
  resolveRuntimeProvider,
  resolveSandboxBox,
  withSandboxProvider,
  type SandboxEvent,
} from './provider-resolution'
import { err, ok } from './result'
import { getSandboxRuntimeConfig, getSandboxRuntimeRegistry, type SandboxRegistryEntry } from './state'

import type {
  AgentSandboxConfig,
  SandboxExecutionOptions,
  SandboxRunResult,
} from '../module-types'
import { getSandboxFeatureProvider } from '../module-types'
import type { ExecutionAuthority } from '@vite-hub/runtime'

const cloudflareRunQueues = new Map<string, Promise<void>>()

async function serializeCloudflareRun<TResult>(id: string | undefined, run: () => Promise<TResult>): Promise<TResult> {
  if (!id) return await run()
  const previous = cloudflareRunQueues.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  cloudflareRunQueues.set(id, current)
  await previous
  try {
    return await run()
  }
  finally {
    release()
    if (cloudflareRunQueues.get(id) === current) cloudflareRunQueues.delete(id)
  }
}

type SandboxRuntimeContext = ResourceRuntimeContext<AgentSandboxConfig, SandboxRegistryEntry, SandboxEvent>
const sandboxRegistry = {}

function isRetriableCloudflareSandboxError(error: unknown) {
  const metadata = readSandboxErrorMetadata(error)

  const provider = metadata?.provider
  if (provider && provider !== 'cloudflare')
    return false
  if (metadata?.code === 'SANDBOX_TIMEOUT')
    return false

  const extraMessage = metadata?.cause instanceof Error ? metadata.cause.message : ''
  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(collectCloudflareErrorMessages(error, extraMessage))
}

export interface SandboxRunner {
  readonly executionAuthority: ExecutionAuthority
  name: string
  run: <TPayload = unknown, TResult = unknown>(
    payload?: TPayload,
    options?: SandboxExecutionOptions,
  ) => Promise<TResult>
}

const sandboxPort: ProviderPort<ResolvedSandboxBox, SandboxRunner, SandboxRuntimeContext> = {
  async resolve(context) {
    assertSandboxDefinitionOptions(context.definition.options ?? {})
    const config = getSandboxFeatureProvider(context.config)
    const provider = resolveRuntimeProvider(config, context.event)

    return await resolveSandboxBox(
      provider,
      withSandboxProvider(provider, config),
      context.definition.options ?? {},
      { event: context.event },
    )
  },
  async create(provider, context) {
    const packageManager = context.definition.bundle.project?.install.command
    const box = await provider.resolveBox(['node', ...(packageManager ? [packageManager] : [])])

    return {
      executionAuthority: box.plan.executionAuthority,
      name: context.name,
      async run<TPayload = unknown, TResult = unknown>(payload?: TPayload, options: SandboxExecutionOptions = {}): Promise<TResult> {
        const cloudflareSandboxId = provider.provider === 'cloudflare'
          ? createCloudflareExecutionSandboxId(context.name, options.sandboxId || provider.sandboxId)
          : undefined
        const attempts = provider.provider === 'cloudflare'
          ? CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1
          : 1

        return await serializeCloudflareRun(cloudflareSandboxId, async () => {
          for (let attempt = 0; attempt < attempts; attempt++) {
            let sandbox: SandboxExecutionBox | undefined
            let handlerMayHaveStarted = false
            try {
              const session = await box.open({ id: cloudflareSandboxId })
              sandbox = createSandboxExecutionBox(session, provider.provider)
              const result = await executeSandboxDefinition<TPayload, TResult>(
                sandbox,
                context.name,
                context.definition.options,
                context.definition.bundle,
                payload,
                options.context,
                {
                  onHandlerStart() {
                    handlerMayHaveStarted = true
                  },
                },
              )
              return result
            }
            catch (error) {
              const sandboxError = toSandboxError(error)
              const shouldRetry = !handlerMayHaveStarted
                && provider.provider === 'cloudflare'
                && attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
                && isRetriableCloudflareSandboxError(sandboxError)

              if (!shouldRetry)
                throw sandboxError

              await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
            }
            finally {
              if (provider.closeAfterRun !== false || (provider.provider === 'cloudflare' && !options.sandboxId && !provider.sandboxId))
                await sandbox?.close().catch(() => {})
            }
          }

          throw sandboxError('Cloudflare sandbox retries exhausted.', {
            code: 'SANDBOX_RUNTIME_ERROR',
            provider: provider.provider,
          })
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
        && (Object.hasOwn(definition.bundle.modules, definition.bundle.entry)
          || (!!definition.bundle.project?.files
            && typeof definition.bundle.project.files === 'object'
            && Object.hasOwn(definition.bundle.project.files, definition.bundle.entry)))
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
  resolveRuntimeProvider,
}
