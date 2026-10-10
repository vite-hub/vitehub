import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS, collectCloudflareErrorMessages } from '../internal/shared/cloudflare-retry'
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
} from './provider-resolution'
import { err, ok } from './result'
import { getSandboxRuntimeConfig, getSandboxRuntimeRegistry, type SandboxRegistryEntry, type SandboxRuntimeRegistry } from './state'

import type {
  AgentSandboxConfig,
  SandboxExecutionOptions,
  SandboxRunResult,
} from '../module-types'
import { getSandboxFeatureProvider } from '../module-types'
import type { ExecutionAuthority } from '@vite-hub/runtime'
import { sandboxErrorDiagnostics } from "../error-diagnostics.ts"

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

async function loadSandboxDefinition(name: string): Promise<SandboxRegistryEntry | undefined> {
  const registry: SandboxRuntimeRegistry = getSandboxRuntimeRegistry() ?? {}
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined
  if (!entry)
    return undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry entries intentionally support generated lazy loader functions and resolved definitions.
  return typeof entry === 'function' ? (await entry()).default : entry
}

function hasValidSandboxBundle(definition: SandboxRegistryEntry) {
  return !!definition.bundle
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Bundles come from generated registry data and require runtime shape validation.
    && typeof definition.bundle === 'object'
    && typeof definition.bundle.entry === 'string'
    && definition.bundle.entry.length > 0
    && !!definition.bundle.modules
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Bundles come from generated registry data and require runtime shape validation.
    && typeof definition.bundle.modules === 'object'
    && (Object.hasOwn(definition.bundle.modules, definition.bundle.entry)
      || (!!definition.bundle.project?.files
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Bundles come from generated registry data and require runtime shape validation.
        && typeof definition.bundle.project.files === 'object'
        && Object.hasOwn(definition.bundle.project.files, definition.bundle.entry)))
}

async function resolveSandboxProvider(
  sandboxConfig: false | AgentSandboxConfig | undefined,
  definition: SandboxRegistryEntry,
): Promise<ResolvedSandboxBox> {
  assertSandboxDefinitionOptions(definition.options ?? {})
  const config = getSandboxFeatureProvider(sandboxConfig)
  const provider = resolveRuntimeProvider(config)

  return await resolveSandboxBox(
    provider,
    withSandboxProvider(provider, config),
    definition.options ?? {},
    {},
  )
}

async function createSandboxRunner(
  name: string,
  definition: SandboxRegistryEntry,
  provider: ResolvedSandboxBox,
): Promise<SandboxRunner> {
  const packageManager = definition.bundle.project?.install.command
  const box = await provider.resolveBox(['node', ...(packageManager ? [packageManager] : [])])

  return {
    executionAuthority: box.plan.executionAuthority,
    name,
    async run<TPayload = unknown, TResult = unknown>(payload?: TPayload, options: SandboxExecutionOptions = {}): Promise<TResult> {
      const cloudflareSandboxId = provider.provider === 'cloudflare'
        ? createCloudflareExecutionSandboxId(name, options.sandboxId || provider.sandboxId)
        : undefined
      const attempts = provider.provider === 'cloudflare'
        ? CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1
        : 1

      return await serializeCloudflareRun(cloudflareSandboxId, async () => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          let sandbox: SandboxExecutionBox | undefined
          let handlerMayHaveStarted = false
          let runError: Error | undefined
          try {
            const session = await box.open({ id: cloudflareSandboxId })
            sandbox = createSandboxExecutionBox(session, provider.provider)
            const result = await executeSandboxDefinition<TPayload>(
              sandbox,
              name,
              definition.options,
              definition.bundle,
              payload,
              options.context,
              {
                onHandlerStart() {
                  handlerMayHaveStarted = true
                },
              },
            )
            // SAFETY: The generated registry binds this runtime Definition to its public result contract.
            return result as TResult
          }
          catch (error) {
            const sandboxError = toSandboxError(error)
            runError = sandboxError
            const shouldRetry = !handlerMayHaveStarted
              && provider.provider === 'cloudflare'
              && attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
              && isRetriableCloudflareSandboxError(sandboxError)

            if (!shouldRetry)
              throw sandboxError

            await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
          }
          finally {
            if (provider.closeAfterRun !== false || (provider.provider === 'cloudflare' && !options.sandboxId && !provider.sandboxId)) {
              try {
                await sandbox?.close()
              }
              catch (cleanupError) {
                if (runError) {
                  throw new AggregateError(
                    [runError, cleanupError],
                    `${runError.message} Cleanup failed: ${toSandboxError(cleanupError).message}`,
                  )
                }
                throw toSandboxError(cleanupError)
              }
            }
          }
        }

        throw sandboxError('Cloudflare sandbox retries exhausted.', {
          code: 'SANDBOX_RUNTIME_ERROR',
          provider: provider.provider,
        })
      })
    },
  }
}

export async function resolveSandboxRunner<TPayload = unknown, TResult = unknown>(name?: string) {
  if (!name)
    throw sandboxErrorDiagnostics.SANDBOX_R0052({ message: '[vitehub] Sandbox name is required. An explicit name is required.' })
  const config = getSandboxRuntimeConfig()
  const definition = await loadSandboxDefinition(name)
  if (!definition)
    throw sandboxErrorDiagnostics.SANDBOX_R0053({ message: `[vitehub] Unknown sandbox "${name}".` })
  if (!hasValidSandboxBundle(definition))
    throw sandboxErrorDiagnostics.SANDBOX_R0054({ message: `[vitehub] Sandbox "${name}" is invalid.` })

  const provider = await resolveSandboxProvider(config, definition)
  // SAFETY: createSandboxRunner returns the generic runner whose run method is narrowed to this invocation's payload and result types.
  return await createSandboxRunner(name, definition, provider) as SandboxRunner & {
    run: (payload?: TPayload, options?: SandboxExecutionOptions) => Promise<TResult>
  }
}

export async function runSandboxRuntime<TPayload = unknown, TResult = unknown>(
  name?: string,
  payload?: TPayload,
  options?: SandboxExecutionOptions,
): Promise<SandboxRunResult> {
  try {
    const sandbox = await resolveSandboxRunner<TPayload, TResult>(name)
    return await ok(await sandbox.run(payload, options))
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
