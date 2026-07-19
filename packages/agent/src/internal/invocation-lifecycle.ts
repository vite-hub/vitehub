import { Deferred, Effect, Exit } from "effect"

import {
  AgentEffectFailure,
  agentEffectCauseValues,
  runAgentEffect,
  tryAgentPromise,
} from "./effect-runtime.ts"

export interface AgentInvocationLifecycle<Outcome> {
  fail: (outcome: Outcome, error: unknown, message: string) => Promise<never>
  finish: (outcome: Outcome) => Promise<void>
}

const failInvocation = Effect.fn("Agent.InvocationLifecycle.fail")(function* <Outcome>(
  deferred: Deferred.Deferred<Outcome>,
  complete: Effect.Effect<void, AgentEffectFailure>,
  outcome: Outcome,
  error: unknown,
  message: string,
) {
  const started = yield* Deferred.succeed(deferred, outcome)
  const exit = yield* Effect.exit(complete)
  if (Exit.isFailure(exit) && started) {
    const causes = agentEffectCauseValues(exit.cause)
    const finishError = causes.length === 1
      ? causes[0]
      : new AggregateError(causes, "[vitehub] Agent finish lifecycle failed for multiple reasons.")
    return yield* Effect.fail(new AgentEffectFailure({
      cause: new AggregateError([error, finishError], message),
    }))
  }
  return yield* Effect.fail(new AgentEffectFailure({
    cause: error,
  }))
})

const makeInvocationLifecycle = Effect.fn("Agent.InvocationLifecycle.open")(function* <Outcome>(
  finish: (outcome: Outcome) => Promise<void>,
) {
  const deferred = yield* Deferred.make<Outcome>()
  const complete = yield* Effect.cached(
    Deferred.await(deferred).pipe(
      Effect.flatMap(value => tryAgentPromise(() => finish(value))),
    ),
  )
  return {
    fail: (outcome: Outcome, error: unknown, message: string) => runAgentEffect(
      failInvocation(deferred, complete, outcome, error, message),
    ),
    finish: (outcome: Outcome) => runAgentEffect(
      Deferred.succeed(deferred, outcome).pipe(
        Effect.andThen(complete),
      ),
    ),
  } satisfies AgentInvocationLifecycle<Outcome>
})

export function openAgentInvocationLifecycle<Outcome>(
  finish: (outcome: Outcome) => Promise<void>,
): Promise<AgentInvocationLifecycle<Outcome>> {
  return runAgentEffect(makeInvocationLifecycle(finish))
}
