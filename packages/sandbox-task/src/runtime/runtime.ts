import { CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE, CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS, collectCloudflareErrorMessages } from '../internal/shared/cloudflare-retry'
import { sleep } from '../internal/shared/utils'
import { sandboxTaskError } from '../sandbox-task/errors'
import { executeSandboxTaskDefinition } from './execute'
import { readSandboxTaskErrorMetadata, toSandboxTaskError } from './error-normalization'
import { createTaskSandbox, type TaskSandbox } from './task-sandbox'
import type { ResolvedTaskSandbox } from './provider-loader'
import {
  assertSandboxTaskDefinitionOptions,
  createCloudflareExecutionSandboxId,
  detectSandbox,
  isSandboxAvailable,
  resolveRuntimeProvider,
  resolveTaskSandbox,
  withSandboxTaskProvider,
} from './provider-resolution'
import { err, ok } from './result'
import { getSandboxTaskRuntimeConfig, getSandboxTaskRuntimeRegistry, type SandboxTaskRegistryEntry, type SandboxTaskRuntimeRegistry } from './state'

import type {
  AgentSandboxTaskConfig,
  SandboxTaskExecutionOptions,
  SandboxTaskRunResult,
} from '../module-types'
import { getSandboxTaskFeatureProvider } from '../module-types'
import type { ExecutionAuthority } from '@vite-hub/runtime'
import { sandboxTaskErrorDiagnostics } from "../error-diagnostics.ts"

const cloudflareRunQueues = new Map<string, Promise<void>>()

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) {
    void promise.catch(() => {})
    throw signal.reason
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function serializeCloudflareRun<TResult>(id: string | undefined, run: () => Promise<TResult>, signal?: AbortSignal): Promise<TResult> {
  if (!id) return await run()
  const previous = cloudflareRunQueues.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  cloudflareRunQueues.set(id, current)
  let started = false
  const releaseAfterPrevious = () => {
    release()
    if (cloudflareRunQueues.get(id) === current)
      cloudflareRunQueues.delete(id)
  }
  try {
    await awaitWithAbort(previous, signal)
    signal?.throwIfAborted()
    started = true
    return await run()
  }
  finally {
    if (started)
      releaseAfterPrevious()
    else
      void previous.then(releaseAfterPrevious, releaseAfterPrevious)
  }
}

function isRetriableCloudflareSandboxError(error: unknown) {
  const metadata = readSandboxTaskErrorMetadata(error)

  const provider = metadata?.provider
  if (provider && provider !== 'cloudflare')
    return false
  if (metadata?.code === 'SANDBOX_TASK_TIMEOUT')
    return false

  const extraMessage = metadata?.cause instanceof Error ? metadata.cause.message : ''
  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(collectCloudflareErrorMessages(error, extraMessage))
}

export interface SandboxTaskRunner {
  readonly executionAuthority: ExecutionAuthority
  name: string
  run: <TPayload = unknown, TResult = unknown>(
    payload?: TPayload,
    options?: SandboxTaskExecutionOptions,
  ) => Promise<TResult>
}

async function loadSandboxTaskDefinition(name: string): Promise<SandboxTaskRegistryEntry | undefined> {
  const registry: SandboxTaskRuntimeRegistry = getSandboxTaskRuntimeRegistry() ?? {}
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined
  if (!entry)
    return undefined
  return typeof entry === 'function' ? (await entry()).default : entry
}

function hasValidSandboxTaskBundle(definition: SandboxTaskRegistryEntry) {
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
}

async function resolveSandboxTaskProvider(
  sandboxTaskConfig: false | AgentSandboxTaskConfig | undefined,
  definition: SandboxTaskRegistryEntry,
): Promise<ResolvedTaskSandbox> {
  assertSandboxTaskDefinitionOptions(definition.options ?? {})
  const config = getSandboxTaskFeatureProvider(sandboxTaskConfig)
  const provider = resolveRuntimeProvider(config)

  return await resolveTaskSandbox(
    provider,
    withSandboxTaskProvider(provider, config),
    definition.options ?? {},
    {},
  )
}

async function createSandboxTaskRunner(
  name: string,
  definition: SandboxTaskRegistryEntry,
  provider: ResolvedTaskSandbox,
): Promise<SandboxTaskRunner> {
  const packageManager = definition.bundle.project?.install.command
  const sandbox = await provider.resolveSandbox(['node', ...(packageManager ? [packageManager] : [])])

  return {
    executionAuthority: sandbox.plan.executionAuthority,
    name,
    async run<TPayload = unknown, TResult = unknown>(payload?: TPayload, options: SandboxTaskExecutionOptions = {}): Promise<TResult> {
      const cloudflareSandboxId = provider.provider === 'cloudflare'
        ? createCloudflareExecutionSandboxId(name, options.sandboxId || provider.sandboxId)
        : undefined
      const attempts = provider.provider === 'cloudflare'
        ? CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1
        : 1

      options.signal?.throwIfAborted()
      const run = serializeCloudflareRun(cloudflareSandboxId, async () => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          let taskSandbox: TaskSandbox | undefined
          let handlerMayHaveStarted = false
          let runError: Error | undefined
          let executionSettled: Promise<void> | undefined
          try {
            const session = options.signal
              ? await sandbox.open({ id: cloudflareSandboxId, signal: options.signal })
              : await sandbox.open({ id: cloudflareSandboxId })
            taskSandbox = createTaskSandbox(session, provider.provider)
            const lifecycle = {
              onExecution(execution: Promise<unknown>) {
                executionSettled = execution.then(() => undefined, () => undefined)
              },
              onHandlerStart() {
                handlerMayHaveStarted = true
              },
            }
            const result = options.signal
              ? await executeSandboxTaskDefinition<TPayload>(taskSandbox, name, definition.options, definition.bundle, payload, options.context, lifecycle, options.signal)
              : await executeSandboxTaskDefinition<TPayload>(taskSandbox, name, definition.options, definition.bundle, payload, options.context, lifecycle)
            // SAFETY: The generated registry binds this runtime Definition to its public result contract.
            return result as TResult
          }
          catch (error) {
            if (options.signal?.aborted)
              throw options.signal.reason ?? error
            const sandboxTaskError = toSandboxTaskError(error)
            runError = sandboxTaskError
            const shouldRetry = !handlerMayHaveStarted
              && provider.provider === 'cloudflare'
              && attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length
              && isRetriableCloudflareSandboxError(sandboxTaskError)

            if (!shouldRetry)
              throw sandboxTaskError

            if (options.signal)
              await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt], options.signal)
            else
              await sleep(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt])
          }
          finally {
            await executionSettled
            if (options.signal?.aborted || readSandboxTaskErrorMetadata(runError)?.code === 'SANDBOX_TASK_TIMEOUT' || provider.closeAfterRun !== false || (provider.provider === 'cloudflare' && !options.sandboxId && !provider.sandboxId)) {
              try {
                await taskSandbox?.close()
              }
              catch (cleanupError) {
                if (options.signal?.aborted)
                  throw options.signal.reason ?? cleanupError
                if (runError) {
                  throw new AggregateError(
                    [runError, cleanupError],
                    `${runError.message} Cleanup failed: ${toSandboxTaskError(cleanupError).message}`,
                  )
                }
                throw toSandboxTaskError(cleanupError)
              }
            }
          }
        }

        throw sandboxTaskError('Cloudflare sandbox retries exhausted.', {
          code: 'SANDBOX_TASK_RUNTIME_ERROR',
          provider: provider.provider,
        })
      }, options.signal)
      return await awaitWithAbort(run, options.signal)
    },
  }
}

export async function resolveSandboxTaskRunner<TPayload = unknown, TResult = unknown>(name?: string) {
  if (!name)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0052({ message: '[vitehub] Sandbox name is required. An explicit name is required.' })
  const config = getSandboxTaskRuntimeConfig()
  const definition = await loadSandboxTaskDefinition(name)
  if (!definition)
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0053({ message: `[vitehub] Unknown Sandbox Task "${name}".` })
  if (!hasValidSandboxTaskBundle(definition))
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0054({ message: `[vitehub] Sandbox "${name}" is invalid.` })

  const provider = await resolveSandboxTaskProvider(config, definition)
  // SAFETY: createSandboxTaskRunner returns the generic runner whose run method is narrowed to this invocation's payload and result types.
  return await createSandboxTaskRunner(name, definition, provider) as SandboxTaskRunner & {
    run: (payload?: TPayload, options?: SandboxTaskExecutionOptions) => Promise<TResult>
  }
}

export async function runSandboxTaskRuntime<TPayload = unknown, TResult = unknown>(
  name?: string,
  payload?: TPayload,
  options?: SandboxTaskExecutionOptions,
): Promise<SandboxTaskRunResult> {
  try {
    options?.signal?.throwIfAborted()
    const sandbox = await resolveSandboxTaskRunner<TPayload, TResult>(name)
    return await ok(await sandbox.run(payload, options))
  }
  catch (error) {
    if (options?.signal?.aborted)
      throw options.signal.reason ?? error
    return err(toSandboxTaskError(error))
  }
}

export {
  detectSandbox,
  isSandboxAvailable,
  resolveRuntimeProvider,
}
