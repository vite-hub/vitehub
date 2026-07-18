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
  const closeExit = yield* Effect.exit(Scope.close(scope, exit))
  const scopeCauses = Exit.isFailure(closeExit)
    ? workspaceEffectCauseValues(closeExit.cause)
    : []
  const releaseCauses = yield* Ref.get(failures)
  const causes = [...scopeCauses, ...releaseCauses]
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
  let pendingRegistrations = Promise.resolve()

  return {
    resource,
    setup,
    close() {
      if (!closePromise) {
        closed = true
        closePromise = pendingRegistrations.then(
          () => runWorkspaceEffect(closeResourceScope(scope, failures, Exit.void, operation)),
        )
      }
      return closePromise
    },
    isClosed: () => closed,
    async runChild(use) {
      if (closed) throw new Error("[vitehub] Workspace resource scope is already closed.")
      let finishRegistration!: () => void
      const registration = new Promise<void>((resolve) => {
        finishRegistration = resolve
      })
      pendingRegistrations = Promise.all([pendingRegistrations, registration]).then(() => {})
      let childScope: Scope.Closeable
      try {
        childScope = await runWorkspaceEffect(Scope.fork(scope, "sequential"))
      }
      catch (error) {
        finishRegistration()
        throw error
      }
      const childFailures = await runWorkspaceEffect(Ref.make<readonly {
        cause: unknown
        parentOwned: boolean
      }[]>([]))

      const useExit = await Promise.resolve().then(() => use(async (finalizer) => {
        try {
          await runWorkspaceEffect(Scope.addFinalizer(
            childScope,
            Effect.catchTag(
              tryWorkspacePromise(`${operation}.Child.release`, () => finalizer()),
              "WorkspaceEffectFailure",
              failure => Effect.gen(function* () {
                const parentOwned = closed
                yield* Ref.update(childFailures, current => [...current, {
                  cause: failure.cause,
                  parentOwned,
                }])
                if (parentOwned) {
                  yield* Ref.update(failures, current => [...current, failure.cause])
                }
              }),
            ),
          ))
        }
        finally {
          finishRegistration()
        }
      })).then(
        value => ({ _tag: "Success", value }) as const,
        error => ({ _tag: "Failure", error }) as const,
      )
      finishRegistration()

      const closeResult = await runWorkspaceEffect(Effect.gen(function* () {
        const exit = yield* Effect.exit(Scope.close(childScope, Exit.void))
        const cleanupCauses = yield* Ref.get(childFailures)
        return { cleanupCauses, exit }
      }))
      const closeCauses = [
        ...(Exit.isFailure(closeResult.exit) ? workspaceEffectCauseValues(closeResult.exit.cause) : []),
        ...closeResult.cleanupCauses.filter(failure => !failure.parentOwned).map(failure => failure.cause),
      ]
      const closeError = closeCauses.length === 0
        ? undefined
        : closeCauses.length === 1
          ? closeCauses[0]
          : new AggregateError(closeCauses, "[vitehub] Workspace child cleanup failed for multiple reasons.")

      if (useExit._tag === "Failure" && closeError !== undefined) {
        throw new AggregateError(
          [useExit.error, closeError],
          "[vitehub] Workspace child operation failed and cleanup also failed.",
        )
      }
      if (useExit._tag === "Failure") throw useExit.error
      if (closeError !== undefined) throw closeError
      return useExit.value
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
