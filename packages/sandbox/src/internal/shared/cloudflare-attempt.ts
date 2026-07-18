import { Cause, Data, Effect, Exit, Schedule } from 'effect'

import { SandboxError } from '../../sandbox/errors'
import { CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS } from './cloudflare-retry'

class CloudflareAttemptFailure extends Data.TaggedError('CloudflareAttemptFailure')<{
  readonly cause: unknown
  readonly retryable: boolean
}> {}

interface CloudflareOperationOptions<T> {
  isRetriable: (error: SandboxError) => boolean
  mapError: (error: unknown) => SandboxError
  operation: string
  run: () => Promise<T>
  timeout: number
}

interface CloudflareSandboxExecutionOptions<TResource, TResult> {
  acquire: () => Promise<TResource>
  isRetriable: (error: SandboxError) => boolean
  mapError: (error: unknown) => SandboxError
  release: (resource: TResource) => Promise<void>
  use: (resource: TResource) => Promise<TResult>
}

const retrySchedule = Schedule.addDelay(
  Schedule.recurs(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length),
  ({ output }) => Effect.succeed(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[output] ?? 0),
)

function interruptionError() {
  const error = new Error('Cloudflare sandbox operation was interrupted.')
  error.name = 'AbortError'
  return error
}

function causeValues(cause: Cause.Cause<CloudflareAttemptFailure>): unknown[] {
  return cause.reasons.map((reason) => {
    if (Cause.isFailReason(reason)) return reason.error.cause
    if (Cause.isDieReason(reason)) return reason.defect
    return interruptionError()
  })
}

function failureFromCause(cause: Cause.Cause<CloudflareAttemptFailure>) {
  const failures = cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)
  if (failures.length === 1 && cause.reasons.length === 1) return failures[0]!
  const causes = causeValues(cause)
  return new CloudflareAttemptFailure({
    cause: causes.length === 1
      ? causes[0]
      : new AggregateError(causes, 'Cloudflare sandbox operation failed for multiple reasons.'),
    retryable: false,
  })
}

function attempt<T>(run: () => Promise<T>, mapError: (error: unknown) => SandboxError, isRetriable: (error: SandboxError) => boolean) {
  return Effect.tryPromise({
    try: () => run(),
    catch: (cause) => {
      const error = mapError(cause)
      return new CloudflareAttemptFailure({ cause: error, retryable: isRetriable(error) })
    },
  })
}

function withRetry<A>(effect: Effect.Effect<A, CloudflareAttemptFailure>) {
  return Effect.retry(effect, {
    schedule: retrySchedule,
    while: failure => failure.retryable,
  })
}

export function cloudflareOperationEffect<T>(options: CloudflareOperationOptions<T>) {
  const operation = attempt(options.run, options.mapError, options.isRetriable).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(new CloudflareAttemptFailure({
        cause: new SandboxError(`Cloudflare sandbox ${options.operation} timed out after ${options.timeout}ms.`, {
          code: 'TIMEOUT',
          details: { operation: options.operation, timeout: options.timeout },
          provider: 'cloudflare',
        }),
        retryable: true,
      })),
    }),
  )
  return withRetry(operation)
}

const cloudflareSandboxExecutionAttempt = Effect.fn('Sandbox.Cloudflare.execute')(function* <TResource, TResult>(
  options: CloudflareSandboxExecutionOptions<TResource, TResult>,
) {
  return yield* Effect.acquireUseRelease(
    attempt(options.acquire, options.mapError, options.isRetriable),
    resource => attempt(() => options.use(resource), options.mapError, options.isRetriable),
    (resource, executionExit) => attempt(
      () => options.release(resource),
      options.mapError,
      () => false,
    ).pipe(Effect.catchTag('CloudflareAttemptFailure', (release) => {
      if (Exit.isSuccess(executionExit)) return Effect.fail(release)
      const execution = failureFromCause(executionExit.cause)
      return Effect.fail(new CloudflareAttemptFailure({
        cause: new AggregateError(
          [execution.cause, release.cause],
          'Cloudflare sandbox execution failed and cleanup also failed.',
        ),
        retryable: false,
      }))
    })),
  )
})

export function cloudflareSandboxExecutionEffect<TResource, TResult>(options: CloudflareSandboxExecutionOptions<TResource, TResult>) {
  return withRetry(cloudflareSandboxExecutionAttempt(options))
}

export async function runCloudflareEffect<T>(effect: Effect.Effect<T, CloudflareAttemptFailure>): Promise<T> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const causes = causeValues(exit.cause)
  if (causes.length === 1) throw causes[0]
  throw new AggregateError(causes, 'Cloudflare sandbox operation failed for multiple reasons.')
}

export function runCloudflareOperation<T>(options: CloudflareOperationOptions<T>): Promise<T> {
  return runCloudflareEffect(cloudflareOperationEffect(options))
}

export function runCloudflareSandboxExecution<TResource, TResult>(options: CloudflareSandboxExecutionOptions<TResource, TResult>): Promise<TResult> {
  return runCloudflareEffect(cloudflareSandboxExecutionEffect(options))
}
