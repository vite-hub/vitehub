import { Effect, Exit, Ref, Scope } from "effect"

import type { MaybePromise } from "../types.ts"

import {
  acquireAgentResource,
  AgentEffectFailure,
  agentEffectCauseValues,
  closeAgentResources,
  runAgentEffect,
  tryAgentPromise,
} from "./effect-runtime.ts"

const addCapability = Effect.fn("Capability.Scope.add")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  close: () => MaybePromise<void>,
) {
  yield* acquireAgentResource(
    scope,
    failures,
    Effect.succeed(close),
    registered => tryAgentPromise("Capability.close", () => registered()),
  )
})

const failCapabilitySetup = Effect.fn("Capability.Scope.failSetup")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  setupError: unknown,
) {
  const closeExit = yield* Effect.exit(closeAgentResources(scope, failures, {
    aggregateMessage: "[vitehub] Multiple capability close callbacks failed.",
    operation: "Capability.Scope.close",
  }))
  if (Exit.isFailure(closeExit)) {
    const closeCauses = agentEffectCauseValues(closeExit.cause)
    const closeError = closeCauses.length === 1
      ? closeCauses[0]
      : new AggregateError(closeCauses, "[vitehub] Multiple capability close callbacks failed.")
    return yield* Effect.fail(
      new AgentEffectFailure({
        cause: new AggregateError(
          [setupError, closeError],
          "[vitehub] Capability setup failed and cleanup also failed.",
        ),
        operation: "Capability.Scope.failSetup",
      }),
    )
  }
  return yield* Effect.fail(
    new AgentEffectFailure({ cause: setupError, operation: "Capability.Scope.failSetup" }),
  )
})

const makeCapabilityScope = Effect.fn("Capability.Scope.open")(function* () {
  const scope = yield* Scope.make("sequential")
  const failures = yield* Ref.make<readonly unknown[]>([])
  return new AgentCapabilityScope(scope, failures)
})

export class AgentCapabilityScope {
  constructor(
    private readonly scope: Scope.Closeable,
    private readonly failures: Ref.Ref<readonly unknown[]>,
  ) {}

  add(close: () => MaybePromise<void>): Promise<void> {
    return runAgentEffect(addCapability(this.scope, this.failures, close))
  }

  close(): Promise<void> {
    return runAgentEffect(closeAgentResources(this.scope, this.failures, {
      aggregateMessage: "[vitehub] Multiple capability close callbacks failed.",
      operation: "Capability.Scope.close",
    }))
  }

  failSetup(error: unknown): Promise<never> {
    return runAgentEffect(failCapabilitySetup(this.scope, this.failures, error))
  }
}

export function openAgentCapabilityScope(): Promise<AgentCapabilityScope> {
  return runAgentEffect(makeCapabilityScope())
}
