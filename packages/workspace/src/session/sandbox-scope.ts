import { Effect, Exit, Ref, Scope } from "effect"

import {
  acquireWorkspaceResource,
  closeWorkspaceResources,
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

export class SandboxWorkspaceScope<Resource extends SandboxResource, Setup> {
  private closed = false

  constructor(
    readonly resource: Resource,
    readonly setup: Setup,
    private readonly scope: Scope.Closeable,
    private readonly failures: Ref.Ref<readonly unknown[]>,
  ) {}

  isClosed(): boolean {
    return this.closed
  }

  close(): Promise<void> {
    this.closed = true
    return runWorkspaceEffect(closeWorkspaceResources(this.scope, this.failures, {
      aggregateMessage: "[vitehub] Workspace sandbox cleanup failed for multiple reasons.",
      operation: "Workspace.Sandbox.Scope.close",
    }))
  }
}

export function openSandboxWorkspaceScope<Resource extends SandboxResource, Setup>(
  acquire: () => Promise<Resource>,
  setup: (resource: Resource) => Promise<Setup>,
): Promise<SandboxWorkspaceScope<Resource, Setup>> {
  return runWorkspaceEffect(Effect.gen(function* () {
    const scope = yield* Scope.make("sequential")
    const failures = yield* Ref.make<readonly unknown[]>([])
    const resource = yield* acquireWorkspaceResource(
      scope,
      failures,
      tryWorkspacePromise("Workspace.Sandbox.acquire", acquire),
      sandbox => sandbox.provider === "vercel"
        ? tryWorkspacePromise("Workspace.Sandbox.release", () => sandbox.stop())
        : Effect.void,
    )

    const setupExit = yield* Effect.exit(
      tryWorkspacePromise("Workspace.Sandbox.setup", () => setup(resource)),
    )
    if (Exit.isSuccess(setupExit))
      return new SandboxWorkspaceScope(resource, setupExit.value, scope, failures)

    const setupError = failureValue(setupExit)
    const closeExit = yield* Effect.exit(closeWorkspaceResources(scope, failures, {
      aggregateMessage: "[vitehub] Workspace sandbox cleanup failed for multiple reasons.",
      exit: setupExit,
      operation: "Workspace.Sandbox.Scope.close",
    }))
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
