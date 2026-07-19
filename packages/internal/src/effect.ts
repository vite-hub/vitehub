import { Cause, Data, Effect, Exit } from "effect"

export class EffectBoundaryFailure extends Data.TaggedError("EffectBoundaryFailure")<{
  readonly cause: unknown
  readonly operation: string
}> {}

interface EffectBoundaryOptions {
  readonly aggregateMessage: string
  readonly interruptionMessage: string
}

export function createEffectBoundary(options: EffectBoundaryOptions) {
  function interruptionError(signal?: AbortSignal): unknown {
    if (signal?.aborted && signal.reason !== undefined) return signal.reason
    const error = new Error(options.interruptionMessage)
    error.name = "AbortError"
    return error
  }

  function causeValues(cause: Cause.Cause<unknown>, signal?: AbortSignal): unknown[] {
    return cause.reasons.map((reason) => {
      if (Cause.isFailReason(reason)) {
        return reason.error instanceof EffectBoundaryFailure ? reason.error.cause : reason.error
      }
      if (Cause.isDieReason(reason)) return reason.defect
      return interruptionError(signal)
    })
  }

  function tryPromise<A>(
    operation: string,
    evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
  ): Effect.Effect<A, EffectBoundaryFailure> {
    return Effect.tryPromise({
      catch: cause => new EffectBoundaryFailure({ cause, operation }),
      try: signal => Promise.resolve(evaluate(signal)),
    })
  }

  async function run<A, E>(
    effect: Effect.Effect<A, E>,
    runOptions: { signal?: AbortSignal } = {},
  ): Promise<A> {
    const exit = await Effect.runPromiseExit(
      effect,
      runOptions.signal ? { signal: runOptions.signal } : undefined,
    )
    if (Exit.isSuccess(exit)) return exit.value
    const causes = causeValues(exit.cause, runOptions.signal)
    if (causes.length === 1) throw causes[0]
    throw new AggregateError(causes, options.aggregateMessage)
  }

  return { causeValues, run, tryPromise }
}
