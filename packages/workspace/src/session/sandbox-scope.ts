import { Effect, Exit, Ref, Scope } from "effect"

import {
  WorkspaceEffectFailure,
  runWorkspaceEffect,
  tryWorkspacePromise,
  workspaceEffectCauseValues,
} from "../internal/effect-runtime.ts"

interface SandboxResource {
  readonly provider: string
  stop(): Promise<void>
}

function failureValue(exit: Exit.Failure<unknown, unknown>): unknown {
  const causes = workspaceEffectCauseValues(exit.cause)
  return causes.length === 1
    ? causes[0]
    : new AggregateError(causes, "[vitehub] Workspace sandbox operation failed for multiple reasons.")
}

const releaseSandbox = Effect.fn("Workspace.Sandbox.release")(function* (
  sandbox: SandboxResource,
  failures: Ref.Ref<readonly unknown[]>,
) {
  if (sandbox.provider !== "vercel") return
  const exit = yield* Effect.exit(
    tryWorkspacePromise("Workspace.Sandbox.release", () => sandbox.stop()),
  )
  if (Exit.isFailure(exit)) {
    const causes = workspaceEffectCauseValues(exit.cause)
    yield* Ref.update(failures, current => [...current, ...causes])
  }
})

const closeSandboxScope = Effect.fn("Workspace.Sandbox.Scope.close")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  exit: Exit.Exit<unknown, unknown>,
) {
  yield* Scope.close(scope, exit)
  const causes = yield* Ref.get(failures)
  if (causes.length === 1) {
    return yield* Effect.fail(new WorkspaceEffectFailure({
      cause: causes[0],
      operation: "Workspace.Sandbox.Scope.close",
    }))
  }
  if (causes.length > 1) {
    return yield* Effect.fail(new WorkspaceEffectFailure({
      cause: new AggregateError(causes, "[vitehub] Workspace sandbox cleanup failed for multiple reasons."),
      operation: "Workspace.Sandbox.Scope.close",
    }))
  }
})

export class SandboxWorkspaceScope<Resource extends SandboxResource, Setup> {
  constructor(
    readonly resource: Resource,
    readonly setup: Setup,
    private readonly scope: Scope.Closeable,
    private readonly failures: Ref.Ref<readonly unknown[]>,
  ) {}

  isClosed(): boolean {
    return this.scope.state._tag === "Closed"
  }

  close(): Promise<void> {
    return runWorkspaceEffect(closeSandboxScope(this.scope, this.failures, Exit.void))
  }
}

export function openSandboxWorkspaceScope<Resource extends SandboxResource, Setup>(
  acquire: () => Promise<Resource>,
  setup: (resource: Resource) => Promise<Setup>,
): Promise<SandboxWorkspaceScope<Resource, Setup>> {
  return runWorkspaceEffect(Effect.gen(function* () {
    const scope = yield* Scope.make("sequential")
    const failures = yield* Ref.make<readonly unknown[]>([])
    const resource = yield* Scope.provide(
      Effect.acquireRelease(
        tryWorkspacePromise("Workspace.Sandbox.acquire", acquire),
        sandbox => releaseSandbox(sandbox, failures),
      ),
      scope,
    )

    const setupExit = yield* Effect.exit(
      tryWorkspacePromise("Workspace.Sandbox.setup", () => setup(resource)),
    )
    if (Exit.isSuccess(setupExit))
      return new SandboxWorkspaceScope(resource, setupExit.value, scope, failures)

    const setupError = failureValue(setupExit)
    const closeExit = yield* Effect.exit(closeSandboxScope(scope, failures, setupExit))
    if (Exit.isFailure(closeExit)) {
      return yield* Effect.fail(new WorkspaceEffectFailure({
        cause: new AggregateError(
          [setupError, failureValue(closeExit)],
          "[vitehub] Workspace sandbox setup failed and cleanup also failed.",
        ),
        operation: "Workspace.Sandbox.setup",
      }))
    }
    return yield* Effect.fail(new WorkspaceEffectFailure({
      cause: setupError,
      operation: "Workspace.Sandbox.setup",
    }))
  }))
}
