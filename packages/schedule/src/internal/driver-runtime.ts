import { AsyncLocalStorage } from "node:async_hooks"

import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, FiberSet, Layer, ManagedRuntime, Option, Queue, Ref, Scheduler, Scope, Semaphore } from "effect"

import { ScheduleError } from "../errors.ts"
import { isRuntimeScheduleDue } from "../runtime/due.ts"
import { executeRuntimeScheduleWake, executeStaticSchedule } from "../runtime/execute.ts"
import {
  getRuntimeScheduleStore,
  getScheduleRunStore,
  getScheduleRuntimeRegistry,
  setRuntimeScheduleStore,
  setScheduleRunStore,
  setScheduleRuntimeRegistry,
} from "../runtime/state.ts"

import type { InstallScheduleRuntimeOptions, RuntimeScheduleWakeDriver } from "../runtime/driver.ts"
import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinition, ScheduleRegistryDefinition } from "../types.ts"

class DriverBoundaryError extends Data.TaggedError("DriverBoundaryError")<{
  readonly cause: unknown
}> {}

interface DeferredOperation {
  readonly completion: Deferred.Deferred<void, DriverBoundaryError>
  readonly effect: Effect.Effect<void, DriverBoundaryError>
}

type PromiseBoundary = <A>(operation: () => PromiseLike<A> | A) => Effect.Effect<A, DriverBoundaryError>

interface OperationContext {
  readonly active: Ref.Ref<boolean>
  readonly deferred: Queue.Queue<DeferredOperation>
  readonly depth: Ref.Ref<number>
  readonly wakeReleases: Ref.Ref<Set<Deferred.Deferred<void>>>
}

interface StaticScheduleDefinitionEntry {
  readonly definition: ScheduleDefinition
  readonly name: string
}

interface StaticScheduleEntry extends StaticScheduleDefinitionEntry {
  readonly record: RuntimeScheduleRecord
}

interface StaticSchedules {
  readonly byId: Map<string, StaticScheduleEntry>
  readonly records: RuntimeScheduleRecord[]
}

interface DriverCoordinator {
  readonly awaitOperations: Effect.Effect<void>
  readonly closeRequested: Deferred.Deferred<void>
  readonly closeResources: (closeDriver: Effect.Effect<void, DriverBoundaryError>) => Effect.Effect<void, DriverBoundaryError>
  readonly coordinate: <A>(
    operation: () => Promise<A>,
    hooks?: {
      readonly onFailure?: Effect.Effect<void>
      readonly onSuccess?: Effect.Effect<void>
    },
  ) => Effect.Effect<A, DriverBoundaryError>
  readonly defer: (effect: Effect.Effect<void, DriverBoundaryError>) => Effect.Effect<void, DriverBoundaryError>
  readonly requestClose: () => void
  readonly run: <A>(operation: (run: PromiseBoundary) => Effect.Effect<A, DriverBoundaryError>) => Promise<A>
  readonly runWake: (operation: () => Promise<void>) => Promise<void>
  readonly waitUntil: (value: PromiseLike<unknown>) => void
}

interface DriverRuntime {
  readonly close: Effect.Effect<void, DriverBoundaryError>
  readonly closeRequested: Deferred.Deferred<void>
  readonly initialize: Effect.Effect<void, DriverBoundaryError>
  readonly requestClose: () => void
}

type InstallationStatus = "aborted" | "initializing" | "ready"

const operationStorage = new AsyncLocalStorage<OperationContext>()
const staticScheduleIdPrefix = "\0vitehub:static:"

class DriverRuntimeService extends Context.Service<DriverRuntimeService, DriverRuntime>()("@vite-hub/schedule/DriverRuntime") {}

function boundary<A>(operation: () => PromiseLike<A> | A): Effect.Effect<A, DriverBoundaryError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: cause => new DriverBoundaryError({ cause }),
  })
}

function unwrapExit<A>(exit: Exit.Exit<A, DriverBoundaryError>): A {
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) throw failure.value.cause
  throw Cause.squash(exit.cause)
}

function throwCause(cause: Cause.Cause<DriverBoundaryError>): never {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) throw failure.value.cause
  throw Cause.squash(cause)
}

function createErrorReporter(onError: InstallScheduleRuntimeOptions["onError"]): (error: unknown) => void {
  return (error) => {
    if (!onError) return
    try {
      void Promise.resolve(onError(error)).catch(() => {})
    }
    catch {}
  }
}

function createCoordinatorScheduler(): Scheduler.Scheduler {
  return new Scheduler.MixedScheduler("async", (run) => {
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) run()
    })
    return () => { canceled = true }
  })
}

function reportErrorEffect(reportError: (error: unknown) => void, error: unknown): Effect.Effect<void> {
  return Effect.sync(() => reportError(error))
}

function isScheduleRegistryDefinition(value: unknown): value is ScheduleRegistryDefinition {
  return !!value && typeof value === "object" && "handler" in value
}

function unwrapDefinition(loaded: ScheduleRegistryDefinition | { default?: ScheduleRegistryDefinition }): ScheduleRegistryDefinition | undefined {
  if ("default" in loaded && isScheduleRegistryDefinition(loaded.default)) return loaded.default
  if (isScheduleRegistryDefinition(loaded)) return loaded
  return undefined
}

function loadStaticDefinitions(registry: InstallScheduleRuntimeOptions["staticRegistry"]): Effect.Effect<StaticScheduleDefinitionEntry[], DriverBoundaryError> {
  if (!registry) return Effect.succeed([])
  return Effect.forEach(Object.entries(registry), ([name, load]) =>
    boundary(async () => {
      const definition = unwrapDefinition(await load())
      return definition && "cron" in definition ? { definition, name } : undefined
    }),
  ).pipe(Effect.map(definitions => definitions.filter((definition): definition is StaticScheduleDefinitionEntry => definition !== undefined)))
}

function createStaticSchedules(definitions: readonly StaticScheduleDefinitionEntry[], runtimeSchedules: readonly RuntimeScheduleRecord[]): StaticSchedules {
  const occupiedIds = new Set(runtimeSchedules.map(schedule => schedule.id))
  const byId = new Map<string, StaticScheduleEntry>()
  const timestamp = new Date(0)
  const records = definitions.map((entry) => {
    const baseId = `${staticScheduleIdPrefix}${encodeURIComponent(entry.name)}`
    let id = baseId
    let suffix = 2
    while (occupiedIds.has(id)) id = `${baseId}:${suffix++}`
    occupiedIds.add(id)
    const record = {
      createdAt: timestamp,
      cron: entry.definition.cron,
      enabled: true,
      id,
      target: entry.name,
      updatedAt: timestamp,
    }
    byId.set(id, { ...entry, record })
    return record
  })
  return { byId, records }
}

const makeDriverCoordinator = Effect.fn("ScheduleDriverCoordinator.make")(function* (
  reportError: (error: unknown) => void,
) {
  const closeRequested = yield* Deferred.make<void>()
  const operationLock = yield* Semaphore.make(1)
  const operationFibers = yield* FiberSet.make<unknown, never>()
  const runOperationFiber = yield* FiberSet.runtimePromise(operationFibers)<never>()
  const waitUntilFibers = yield* FiberSet.make<unknown, never>()
  const runWaitUntilFiber = yield* FiberSet.runtimePromise(waitUntilFibers)<never>()
  const wakeFibers = yield* FiberSet.make<void, DriverBoundaryError>()

  const runEffect = <A>(effect: Effect.Effect<A, DriverBoundaryError>): Promise<A> =>
    runOperationFiber(Effect.exit(effect)).then(unwrapExit)

  const drainDeferred = (context: OperationContext): Effect.Effect<void> => Effect.gen(function* () {
    while (true) {
      const deferred = yield* Queue.clear(context.deferred)
      if (deferred.length === 0) return
      yield* Effect.forEach(
        deferred,
        entry => Deferred.complete(entry.completion, entry.effect),
        { discard: true },
      )
    }
  })

  const coordinateEffect = <A>(
    operation: (context: OperationContext) => Effect.Effect<A, DriverBoundaryError>,
    hooks: {
      readonly onFailure?: Effect.Effect<void>
      readonly onSuccess?: Effect.Effect<void>
    } = {},
  ): Effect.Effect<A, DriverBoundaryError> => Effect.suspend(() => {
    const activeOperation = operationStorage.getStore()
    if (activeOperation && Ref.getUnsafe(activeOperation.active)) {
      return Ref.update(activeOperation.depth, depth => depth + 1).pipe(
        Effect.andThen(operation(activeOperation)),
        Effect.tap(() => hooks.onSuccess ?? Effect.void),
        Effect.tapError(() => hooks.onFailure ?? Effect.void),
        Effect.ensuring(Ref.update(activeOperation.depth, depth => depth - 1)),
      )
    }

    return operationLock.withPermits(1)(Effect.gen(function* () {
      const context: OperationContext = {
        active: yield* Ref.make(true),
        deferred: yield* Queue.unbounded<DeferredOperation>(),
        depth: yield* Ref.make(0),
        wakeReleases: yield* Ref.make(new Set<Deferred.Deferred<void>>()),
      }
      return yield* operation(context).pipe(
        Effect.tap(() => hooks.onSuccess ?? Effect.void),
        Effect.tapError(() => hooks.onFailure ?? Effect.void),
        Effect.tap(() => drainDeferred(context)),
        Effect.ensuring(Ref.set(context.active, false)),
      )
    }))
  })

  const coordinate = <A>(
    operation: () => Promise<A>,
    hooks: {
      readonly onFailure?: Effect.Effect<void>
      readonly onSuccess?: Effect.Effect<void>
    } = {},
  ): Effect.Effect<A, DriverBoundaryError> => coordinateEffect(
    context => boundary(() => operationStorage.run(context, operation)),
    hooks,
  )

  const defer = (effect: Effect.Effect<void, DriverBoundaryError>): Effect.Effect<void, DriverBoundaryError> => Effect.suspend(() => {
    const activeOperation = operationStorage.getStore()
    if (
      !activeOperation ||
      !Ref.getUnsafe(activeOperation.active) ||
      Ref.getUnsafe(activeOperation.depth) === 0
    ) return effect

    const completion = Deferred.makeUnsafe<void, DriverBoundaryError>()
    return Effect.gen(function* () {
      yield* Queue.offer(activeOperation.deferred, {
        completion,
        effect,
      })
      const releases = yield* Ref.get(activeOperation.wakeReleases)
      yield* Effect.forEach(releases, release => Deferred.succeed(release, undefined), { discard: true })
      yield* Deferred.await(completion)
    })
  })

  const runWakeEffect = (operation: () => Promise<void>): Effect.Effect<void, DriverBoundaryError> => Effect.gen(function* () {
    const activeOperation = operationStorage.getStore()
    if (!activeOperation || !Ref.getUnsafe(activeOperation.active)) {
      const fiber = yield* FiberSet.run(wakeFibers, boundary(operation), { startImmediately: true })
      return yield* Fiber.join(fiber)
    }

    const release = yield* Deferred.make<void>()
    yield* Ref.update(activeOperation.wakeReleases, releases => new Set(releases).add(release))
    const fiber = yield* FiberSet.run(wakeFibers, boundary(operation), { startImmediately: true })
    try {
      const result = yield* Effect.raceFirst(
        Fiber.join(fiber).pipe(Effect.as("completed" as const)),
        Deferred.await(release).pipe(Effect.as("released" as const)),
      )
      if (result === "released") {
        yield* Queue.offer(activeOperation.deferred, {
          completion: Deferred.makeUnsafe<void, DriverBoundaryError>(),
          effect: Fiber.join(fiber),
        })
      }
    }
    finally {
      yield* Ref.update(activeOperation.wakeReleases, (releases) => {
        const next = new Set(releases)
        next.delete(release)
        return next
      })
    }
  })

  const waitUntil = (value: PromiseLike<unknown>): void => {
    void runWaitUntilFiber(Effect.exit(
      boundary(() => value).pipe(
        Effect.catchTag("DriverBoundaryError", error => reportErrorEffect(reportError, error.cause)),
      ),
    ))
  }

  return {
    awaitOperations: FiberSet.awaitEmpty(operationFibers),
    closeRequested,
    closeResources: closeDriver => Effect.gen(function* () {
      yield* Deferred.await(closeRequested)
      yield* FiberSet.awaitEmpty(wakeFibers)
      yield* operationLock.withPermits(1)(Effect.void)
      yield* FiberSet.awaitEmpty(waitUntilFibers)
      yield* closeDriver
    }),
    coordinate,
    defer,
    requestClose() {
      Deferred.doneUnsafe(closeRequested, Effect.void)
    },
    run: operation => runEffect(coordinateEffect(
      context => operation(operation => boundary(() => operationStorage.run(context, operation))),
    )),
    runWake(operation) {
      if (Deferred.isDoneUnsafe(closeRequested)) return Promise.resolve()
      return runEffect(runWakeEffect(operation))
    },
    waitUntil,
  } satisfies DriverCoordinator
})

function reconcileAfterMutation(
  driver: RuntimeScheduleWakeDriver,
  store: RuntimeScheduleStore,
  rollback: Effect.Effect<void, DriverBoundaryError>,
  reportError: (error: unknown) => void,
  run: PromiseBoundary,
): Effect.Effect<void, DriverBoundaryError> {
  const reconcile = Effect.flatMap(
    run(() => store.list()),
    records => run(() => driver.reconcile(records)),
  )
  return reconcile.pipe(
    Effect.catchTag("DriverBoundaryError", primaryError =>
      rollback.pipe(
        Effect.catchTag("DriverBoundaryError", rollbackError =>
          Effect.fail(new DriverBoundaryError({
            cause: new AggregateError(
              [primaryError.cause, rollbackError.cause],
              "Runtime Schedule reconciliation failed and the stored record could not be rolled back.",
            ),
          })),
        ),
        Effect.andThen(reconcile.pipe(
          Effect.catchTag("DriverBoundaryError", error => reportErrorEffect(reportError, error.cause)),
        )),
        Effect.andThen(Effect.fail(primaryError)),
      ),
    ),
  )
}

function createReconciledStore(
  store: RuntimeScheduleStore,
  driver: RuntimeScheduleWakeDriver,
  status: Ref.Ref<InstallationStatus>,
  reportError: (error: unknown) => void,
  coordinator: DriverCoordinator,
): RuntimeScheduleStore {
  const getDriver = Effect.suspend(() => Ref.getUnsafe(status) === "aborted"
    ? Effect.fail(new DriverBoundaryError({ cause: new Error("Runtime Schedule wake driver installation did not complete.") }))
    : Effect.succeed(driver))
  const rollbackFailure = (message: string) => Effect.fail(
    new DriverBoundaryError({ cause: new Error(message) }),
  )
  return {
    create(record) {
      return coordinator.run(run => Effect.gen(function* () {
        const installedDriver = yield* getDriver
        const created = yield* run(() => store.create(record))
        yield* coordinator.defer(reconcileAfterMutation(installedDriver, store, Effect.gen(function* () {
          const deleted = yield* run(() => store.delete(created.id))
          if (!deleted) yield* rollbackFailure(`Runtime Schedule create rollback failed: ${created.id}`)
        }), reportError, run))
        return created
      }))
    },
    delete(id) {
      return coordinator.run(run => Effect.gen(function* () {
        const installedDriver = yield* getDriver
        const previous = yield* run(() => store.get(id))
        const deleted = yield* run(() => store.delete(id))
        if (!deleted) return false
        yield* coordinator.defer(reconcileAfterMutation(installedDriver, store, Effect.gen(function* () {
          if (!previous) return yield* rollbackFailure(`Runtime Schedule delete rollback failed: ${id}`)
          yield* run(() => store.create(previous))
        }), reportError, run))
        return true
      }))
    },
    get(id) {
      return store.get(id)
    },
    list() {
      return store.list()
    },
    update(id, patch) {
      return coordinator.run(run => Effect.gen(function* () {
        const installedDriver = yield* getDriver
        const previous = yield* run(() => store.get(id))
        const updated = yield* run(() => store.update(id, patch))
        if (!updated) return undefined
        yield* coordinator.defer(reconcileAfterMutation(installedDriver, store, Effect.gen(function* () {
          if (!previous) {
            const deleted = yield* run(() => store.delete(id))
            if (!deleted) yield* rollbackFailure(`Runtime Schedule update rollback failed: ${id}`)
            return
          }
          const deleted = yield* run(() => store.delete(id))
          if (!deleted) yield* rollbackFailure(`Runtime Schedule update rollback failed: ${id}`)
          yield* run(() => store.create(previous))
        }), reportError, run))
        return updated
      }))
    },
  }
}

function closeDriver(
  driver: RuntimeScheduleWakeDriver,
  closed: Ref.Ref<boolean>,
): Effect.Effect<void, DriverBoundaryError> {
  return Ref.modify(closed, value => [!value, true] as const).pipe(
    Effect.flatMap(shouldClose => shouldClose ? boundary(() => driver.close?.()) : Effect.void),
  )
}

const makeDriverRuntime = Effect.fn("ScheduleDriver.install")(function* (
  options: InstallScheduleRuntimeOptions,
) {
  const previousRegistry = getScheduleRuntimeRegistry()
  const previousRuntimeScheduleStore = getRuntimeScheduleStore()
  const previousScheduleRunStore = getScheduleRunStore()
  const reportError = createErrorReporter(options.onError)
  const status = yield* Ref.make<InstallationStatus>("initializing")
  const coordinator = yield* makeDriverCoordinator(reportError)
  const driverClosed = yield* Ref.make(false)
  const driverRef = yield* Ref.make<RuntimeScheduleWakeDriver | undefined>(undefined)
  const driverScope = yield* Scope.make("sequential")
  yield* Effect.addFinalizer(() => Scope.close(driverScope, Exit.void))

  const restoreRuntimeState = Effect.sync(() => {
    setScheduleRuntimeRegistry(previousRegistry)
    setRuntimeScheduleStore(previousRuntimeScheduleStore)
    setScheduleRunStore(previousScheduleRunStore)
  })

  const closeInstalledDriver = Effect.flatMap(Ref.get(driverRef), driver =>
    driver ? closeDriver(driver, driverClosed) : Effect.void,
  )

  const initialize = Effect.gen(function* () {
    yield* Effect.sync(() => {
      setScheduleRuntimeRegistry(options.registry)
      setScheduleRunStore(options.scheduleRunStore)
    })

    const runtimeSchedules = yield* boundary(() => options.runtimeScheduleStore.list())
    const staticSchedules = createStaticSchedules(
      yield* loadStaticDefinitions(options.staticRegistry),
      runtimeSchedules,
    )
    const driver = yield* Effect.acquireRelease(
      boundary(() => options.createDriver({
        reportError,
        wake(input: RuntimeScheduleWake) {
          return coordinator.runWake(async () => {
            const staticSchedule = staticSchedules.byId.get(input.scheduleId)
            if (staticSchedule) {
              if (!isRuntimeScheduleDue(staticSchedule.record, input.scheduledAt)) {
                throw new ScheduleError(`Static Schedule is not due: ${staticSchedule.name}`, {
                  code: "SCHEDULE_NOT_DUE",
                  details: { id: input.scheduleId, scheduledAt: input.scheduledAt },
                  httpStatus: 409,
                })
              }
              await executeStaticSchedule({
                cron: staticSchedule.definition.cron,
                definition: staticSchedule.definition,
                name: staticSchedule.name,
                scheduledAt: input.scheduledAt,
                waitUntil: coordinator.waitUntil,
              })
              return
            }
            await executeRuntimeScheduleWake(input, {
              runtimeScheduleStore: options.runtimeScheduleStore,
              scheduleRunStore: options.scheduleRunStore,
              waitUntil: coordinator.waitUntil,
            })
          })
        },
      })),
      driver => closeDriver(driver, driverClosed).pipe(
        Effect.catchTag("DriverBoundaryError", error => reportErrorEffect(reportError, error.cause)),
      ),
    ).pipe(Effect.provideService(Scope.Scope, driverScope))
    yield* Ref.set(driverRef, driver)

    const reconciledDriver: RuntimeScheduleWakeDriver = {
      close: () => driver.close?.(),
      async reconcile(records) {
        const conflictingId = records.find(record => staticSchedules.byId.has(record.id))?.id
        if (conflictingId) {
          throw new Error(`Runtime Schedule id conflicts with a Static Schedule driver identity: ${JSON.stringify(conflictingId)}`)
        }
        await driver.reconcile([...staticSchedules.records, ...records])
      },
    }
    const runtimeScheduleStore = createReconciledStore(
      options.runtimeScheduleStore,
      reconciledDriver,
      status,
      reportError,
      coordinator,
    )
    yield* Effect.sync(() => setRuntimeScheduleStore(runtimeScheduleStore))
    yield* coordinator.coordinate(
      () => reconciledDriver.reconcile(runtimeSchedules),
      {
        onFailure: Ref.set(status, "aborted"),
        onSuccess: Ref.set(status, "ready"),
      },
    )
  })

  const guardedInitialize = initialize.pipe(
    Effect.tapError(() => Ref.set(status, "aborted")),
    Effect.tapError(() => coordinator.awaitOperations),
    Effect.tapError(() => Scope.close(driverScope, Exit.void)),
    Effect.tapError(() => restoreRuntimeState),
  )

  return {
    close: coordinator.closeResources(
      closeInstalledDriver.pipe(Effect.ensuring(Scope.close(driverScope, Exit.void))),
    ),
    closeRequested: coordinator.closeRequested,
    initialize: guardedInitialize,
    requestClose: coordinator.requestClose,
  } satisfies DriverRuntime
})

export async function installScheduleDriverRuntime(options: InstallScheduleRuntimeOptions): Promise<{ close(): Promise<void> }> {
  const DriverRuntimeLive = Layer.effect(DriverRuntimeService, makeDriverRuntime(options)).pipe(
    Layer.provide(Layer.succeed(Scheduler.Scheduler, createCoordinatorScheduler())),
  )
  const runtime = ManagedRuntime.make(DriverRuntimeLive)
  const service = runtime.runSync(DriverRuntimeService)
  const installation = await runtime.runPromise(Effect.exit(service.initialize))
  if (Exit.isFailure(installation)) {
    await runtime.dispose()
    throwCause(installation.cause)
  }
  const closeResult = runtime.runPromise(Effect.exit(
    Deferred.await(service.closeRequested).pipe(Effect.andThen(service.close)),
  ))
  const closing = closeResult.then(async (exit) => {
    await runtime.dispose()
    return unwrapExit(exit)
  })

  return {
    close() {
      service.requestClose()
      return closing
    },
  }
}
