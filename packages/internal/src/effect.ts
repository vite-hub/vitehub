import { Cause, Data, Effect, Exit, Ref, Scope } from "effect"

export class EffectBoundaryFailure extends Data.TaggedError("EffectBoundaryFailure")<{
  readonly cause: unknown
}> {}

interface EffectBoundaryOptions {
  readonly aggregateMessage: string
  readonly interruptionMessage: string
}

interface CloseScopeOptions {
  readonly aggregateMessage?: string
  readonly exit?: Exit.Exit<unknown, unknown>
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
    evaluate: (signal: AbortSignal) => PromiseLike<A> | A,
  ): Effect.Effect<A, EffectBoundaryFailure> {
    return Effect.tryPromise({
      catch: cause => new EffectBoundaryFailure({ cause }),
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

  function acquireWithCapturedRelease<A, E, R, E2, R2>(
    scope: Scope.Closeable,
    failures: Ref.Ref<readonly unknown[]>,
    acquire: Effect.Effect<A, E, R>,
    release: (resource: A, exit: Exit.Exit<unknown, unknown>) => Effect.Effect<unknown, E2, R2>,
  ): Effect.Effect<A, E, R | R2> {
    return Scope.provide(
      Effect.acquireRelease(
        acquire,
        (resource, exit) => Effect.matchCauseEffect(release(resource, exit), {
          onFailure: cause => Ref.update(failures, current => [...current, ...causeValues(cause)]),
          onSuccess: () => Effect.void,
        }),
      ),
      scope,
    )
  }

  function closeScopeWithCapturedReleases(
    scope: Scope.Closeable,
    failures: Ref.Ref<readonly unknown[]>,
    closeOptions: CloseScopeOptions,
  ): Effect.Effect<void, EffectBoundaryFailure> {
    return Effect.gen(function* () {
      yield* Scope.close(scope, closeOptions.exit ?? Exit.void)
      const causes = yield* Ref.get(failures)
      if (causes.length === 0) return
      const cause = causes.length === 1
        ? causes[0]
        : new AggregateError(causes, closeOptions.aggregateMessage ?? options.aggregateMessage)
      return yield* Effect.fail(new EffectBoundaryFailure({ cause }))
    })
  }

  return { acquireWithCapturedRelease, causeValues, closeScopeWithCapturedReleases, run, tryPromise }
}
