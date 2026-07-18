import { Deferred, Effect, Exit } from "effect"

import {
  AgentEffectFailure,
  agentEffectCauseValues,
  runAgentEffect,
  tryAgentPromise,
} from "./effect-runtime.ts"

const makeInvocationLifecycle = Effect.fn("Agent.InvocationLifecycle.open")(function* <Outcome>(
  finish: (outcome: Outcome) => Promise<void>,
) {
  const outcome = yield* Deferred.make<Outcome>()
  const complete = yield* Effect.cached(
    Deferred.await(outcome).pipe(
      Effect.flatMap(value => tryAgentPromise("Agent.InvocationLifecycle.finish", () => finish(value))),
    ),
  )
  return new AgentInvocationLifecycle(outcome, complete)
})

export class AgentInvocationLifecycle<Outcome> {
  constructor(
    private readonly outcome: Deferred.Deferred<Outcome>,
    private readonly complete: Effect.Effect<void, AgentEffectFailure>,
  ) {}

  finish(outcome: Outcome): Promise<void> {
    return runAgentEffect(
      Deferred.succeed(this.outcome, outcome).pipe(
        Effect.andThen(this.complete),
      ),
    )
  }

  fail(outcome: Outcome, error: unknown, message: string): Promise<never> {
    const { complete, outcome: lifecycleOutcome } = this
    return runAgentEffect(Effect.gen(function* () {
      const started = yield* Deferred.succeed(lifecycleOutcome, outcome)
      const exit = yield* Effect.exit(complete)
      if (Exit.isFailure(exit) && started) {
        const causes = agentEffectCauseValues(exit.cause)
        const finishError = causes.length === 1
          ? causes[0]
          : new AggregateError(causes, "[vitehub] Agent finish lifecycle failed for multiple reasons.")
        return yield* Effect.fail(new AgentEffectFailure({
          cause: new AggregateError([error, finishError], message),
          operation: "Agent.InvocationLifecycle.fail",
        }))
      }
      return yield* Effect.fail(new AgentEffectFailure({
        cause: error,
        operation: "Agent.InvocationLifecycle.fail",
      }))
    }))
  }
}

export function openAgentInvocationLifecycle<Outcome>(
  finish: (outcome: Outcome) => Promise<void>,
): Promise<AgentInvocationLifecycle<Outcome>> {
  return runAgentEffect(makeInvocationLifecycle(finish))
}
