import { Effect, Exit, Ref, Scope } from "effect"

import type { MaybePromise } from "../types.ts"

import {
  AgentEffectFailure,
  agentEffectCauseValues,
  runAgentEffect,
  tryAgentPromise,
} from "./effect-runtime.ts"

const closeCapability = Effect.fn("Capability.close")(function* (
  close: () => MaybePromise<void>,
  failures: Ref.Ref<readonly unknown[]>,
) {
  const exit = yield* Effect.exit(tryAgentPromise("Capability.close", () => close()))
  if (Exit.isFailure(exit)) {
    const causes = agentEffectCauseValues(exit.cause)
    yield* Ref.update(failures, current => [...current, ...causes])
  }
})

const addCapability = Effect.fn("Capability.Scope.add")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  close: () => MaybePromise<void>,
) {
  yield* Scope.provide(
    Effect.acquireRelease(
      Effect.succeed(close),
      registered => closeCapability(registered, failures),
    ),
    scope,
  )
})

const closeCapabilityScope = Effect.fn("Capability.Scope.close")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
) {
  yield* Scope.close(scope, Exit.void)
  const causes = yield* Ref.get(failures)
  if (causes.length === 1) {
    return yield* Effect.fail(
      new AgentEffectFailure({ cause: causes[0], operation: "Capability.Scope.close" }),
    )
  }
  if (causes.length > 1) {
    return yield* Effect.fail(
      new AgentEffectFailure({
        cause: new AggregateError(causes, "[vitehub] Multiple capability close callbacks failed."),
        operation: "Capability.Scope.close",
      }),
    )
  }
})

const failCapabilitySetup = Effect.fn("Capability.Scope.failSetup")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  setupError: unknown,
) {
  const closeExit = yield* Effect.exit(closeCapabilityScope(scope, failures))
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
    return runAgentEffect(closeCapabilityScope(this.scope, this.failures))
  }

  failSetup(error: unknown): Promise<never> {
    return runAgentEffect(failCapabilitySetup(this.scope, this.failures, error))
  }
}

export function openAgentCapabilityScope(): Promise<AgentCapabilityScope> {
  return runAgentEffect(makeCapabilityScope())
}
