import { Cause, Data, Effect, Exit } from "effect"

export class WorkspaceEffectFailure extends Data.TaggedError("WorkspaceEffectFailure")<{
  readonly cause: unknown
  readonly operation: string
}> {}

function interruptionError(signal?: AbortSignal): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason
  const error = new Error("[vitehub] Workspace operation was interrupted.")
  error.name = "AbortError"
  return error
}

export function workspaceEffectCauseValues(
  cause: Cause.Cause<unknown>,
  signal?: AbortSignal,
): unknown[] {
  return cause.reasons.map(reason => {
    if (Cause.isFailReason(reason)) {
      return reason.error instanceof WorkspaceEffectFailure ? reason.error.cause : reason.error
    }
    if (Cause.isDieReason(reason)) {
      return reason.defect
    }
    return interruptionError(signal)
  })
}

export function tryWorkspacePromise<A>(
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
): Effect.Effect<A, WorkspaceEffectFailure> {
  return Effect.tryPromise({
    catch: cause => new WorkspaceEffectFailure({ cause, operation }),
    try: signal => Promise.resolve(evaluate(signal)),
  })
}

export async function runWorkspaceEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined)
  if (Exit.isSuccess(exit)) return exit.value
  const causes = workspaceEffectCauseValues(exit.cause, options.signal)
  if (causes.length === 1) throw causes[0]
  throw new AggregateError(causes, "[vitehub] Workspace operation failed for multiple reasons.")
}
