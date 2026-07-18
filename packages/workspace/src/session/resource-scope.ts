import { Effect, Exit, Ref, Scope } from "effect"

import {
  WorkspaceEffectFailure,
  runWorkspaceEffect,
  tryWorkspacePromise,
  workspaceEffectCauseValues,
} from "../internal/effect-runtime.ts"

function failureValue(exit: Exit.Failure<unknown, unknown>): unknown {
  const causes = workspaceEffectCauseValues(exit.cause)
  return causes.length === 1
    ? causes[0]
    : new AggregateError(causes, "[vitehub] Workspace resource operation failed for multiple reasons.")
}

const releaseResource = Effect.fn("Workspace.ResourceScope.release")(function* <Resource>(
  resource: Resource,
  release: (resource: Resource) => Promise<void>,
  failures: Ref.Ref<readonly unknown[]>,
  operation: string,
) {
  const exit = yield* Effect.exit(tryWorkspacePromise(`${operation}.release`, () => release(resource)))
  if (Exit.isFailure(exit)) {
    const causes = workspaceEffectCauseValues(exit.cause)
    yield* Ref.update(failures, current => [...current, ...causes])
  }
})

const closeResourceScope = Effect.fn("Workspace.ResourceScope.close")(function* (
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  exit: Exit.Exit<unknown, unknown>,
  operation: string,
) {
  yield* Scope.close(scope, exit)
  const causes = yield* Ref.get(failures)
  if (causes.length) {
    return yield* Effect.fail(new WorkspaceEffectFailure({
      cause: causes.length === 1
        ? causes[0]
        : new AggregateError(causes, "[vitehub] Workspace resource cleanup failed for multiple reasons."),
      operation: `${operation}.Scope.close`,
    }))
  }
})

export interface WorkspaceResourceScope<Resource, Setup> {
  readonly resource: Resource
  readonly setup: Setup
  close(): Promise<void>
  isClosed(): boolean
  runChild<A>(use: (registerFinalizer: (finalizer: () => Promise<void>) => Promise<void>) => Promise<A>): Promise<A>
}

interface WorkspaceResourceScopeOptions<Resource, Setup> {
  readonly acquire: () => Promise<Resource>
  readonly operation: string
  readonly release: (resource: Resource) => Promise<void>
  readonly setup: (resource: Resource) => Promise<Setup>
}

function makeWorkspaceResourceScope<Resource, Setup>(
  resource: Resource,
  setup: Setup,
  scope: Scope.Closeable,
  failures: Ref.Ref<readonly unknown[]>,
  operation: string,
): WorkspaceResourceScope<Resource, Setup> {
  let closed = false
  let closePromise: Promise<void> | undefined

  return {
    resource,
    setup,
    close() {
      if (!closePromise) {
        closed = true
        closePromise = runWorkspaceEffect(closeResourceScope(scope, failures, Exit.void, operation))
      }
      return closePromise
    },
    isClosed: () => closed,
    async runChild(use) {
      const childScope = await runWorkspaceEffect(Scope.fork(scope, "sequential"))
      if (closed) {
        await runWorkspaceEffect(Scope.close(childScope, Exit.void))
        throw new Error("[vitehub] Workspace resource scope is already closed.")
      }
      try {
        return await use(finalizer => runWorkspaceEffect(
          Scope.addFinalizer(childScope, Effect.promise(finalizer)),
        ))
      }
      finally {
        await runWorkspaceEffect(Scope.close(childScope, Exit.void))
      }
    },
  }
}

export function openWorkspaceResourceScope<Resource, Setup>(
  options: WorkspaceResourceScopeOptions<Resource, Setup>,
): Promise<WorkspaceResourceScope<Resource, Setup>> {
  const { acquire, operation, release, setup } = options
  return runWorkspaceEffect(Effect.gen(function* () {
    const scope = yield* Scope.make("sequential")
    const failures = yield* Ref.make<readonly unknown[]>([])
    const resource = yield* Scope.provide(
      Effect.acquireRelease(
        tryWorkspacePromise(`${operation}.acquire`, acquire),
        resource => releaseResource(resource, release, failures, operation),
      ),
      scope,
    )

    const setupExit = yield* Effect.exit(tryWorkspacePromise(`${operation}.setup`, () => setup(resource)))
    if (Exit.isSuccess(setupExit))
      return makeWorkspaceResourceScope(resource, setupExit.value, scope, failures, operation)

    const setupError = failureValue(setupExit)
    const closeExit = yield* Effect.exit(closeResourceScope(scope, failures, setupExit, operation))
    if (Exit.isFailure(closeExit)) {
      return yield* Effect.fail(new WorkspaceEffectFailure({
        cause: new AggregateError(
          [setupError, failureValue(closeExit)],
          "[vitehub] Workspace resource setup failed and cleanup also failed.",
        ),
        operation: `${operation}.setup`,
      }))
    }
    return yield* Effect.fail(new WorkspaceEffectFailure({ cause: setupError, operation: `${operation}.setup` }))
  }))
}
