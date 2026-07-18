import { Cause, Data, Effect, Exit } from "effect"

export class AgentEffectFailure extends Data.TaggedError("AgentEffectFailure")<{
  readonly cause: unknown
  readonly operation: string
}> {}

function interruptionError(signal?: AbortSignal): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason
  const error = new Error("[vitehub] Agent operation was interrupted.")
  error.name = "AbortError"
  return error
}

export function agentEffectCauseValues(
  cause: Cause.Cause<unknown>,
  signal?: AbortSignal,
): unknown[] {
  return cause.reasons.map(reason => {
    if (Cause.isFailReason(reason)) {
      return reason.error instanceof AgentEffectFailure ? reason.error.cause : reason.error
    }
    if (Cause.isDieReason(reason)) return reason.defect
    return interruptionError(signal)
  })
}

export function tryAgentPromise<A>(
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
): Effect.Effect<A, AgentEffectFailure> {
  return Effect.tryPromise({
    catch: cause => new AgentEffectFailure({ cause, operation }),
    try: signal => Promise.resolve(evaluate(signal)),
  })
}

export async function runAgentEffect<A, E>(
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal } = {},
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined)
  if (Exit.isSuccess(exit)) return exit.value
  const causes = agentEffectCauseValues(exit.cause, options.signal)
  if (causes.length === 1) throw causes[0]
  throw new AggregateError(causes, "[vitehub] Agent operation failed for multiple reasons.")
}
