import { Cause, Clock, Data, Duration, Effect, Exit, FiberSet, Queue, Ref, Semaphore } from "effect"

import { isRuntimeScheduleDue } from "../runtime/due.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleWake } from "../types.ts"
import type { RuntimeScheduleWakeDriverContext } from "../runtime/driver.ts"

export class ProcessWakeBoundaryError extends Data.TaggedError("ProcessWakeBoundaryError")<{
  readonly cause: unknown
}> {}

function interruptionError(signal?: AbortSignal): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason
  const error = new Error("[vitehub] Process Schedule Wake Driver operation was interrupted.")
  error.name = "AbortError"
  return error
}

function processWakeCauseValues(
  cause: Cause.Cause<unknown>,
  signal?: AbortSignal,
): unknown[] {
  return cause.reasons.map((reason) => {
    if (Cause.isFailReason(reason)) {
      return reason.error instanceof ProcessWakeBoundaryError ? reason.error.cause : reason.error
    }
    if (Cause.isDieReason(reason)) return reason.defect
    return interruptionError(signal)
  })
}

export async function unwrapProcessWakeExit<A>(
  promise: Promise<Exit.Exit<A, ProcessWakeBoundaryError>>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await promise
  if (Exit.isSuccess(exit)) return exit.value
  const causes = processWakeCauseValues(exit.cause, signal)
  if (causes.length === 1) throw causes[0]
  throw new AggregateError(causes, "[vitehub] Process Schedule Wake Driver operation failed for multiple reasons.")
}

interface ProcessWakeState {
  readonly active: Set<string>
  readonly closed: boolean
  readonly closing: boolean
  readonly dispatched: Set<string>
  readonly occurrenceMinute?: number
  readonly queued: Map<string, RuntimeScheduleWake>
  readonly schedules: Map<string, RuntimeScheduleRecord>
  readonly started: boolean
}

export interface ProcessWakeRuntime {
  readonly close: Effect.Effect<void>
  readonly reconcile: (
    records: readonly RuntimeScheduleRecord[],
  ) => Effect.Effect<void, ProcessWakeBoundaryError>
}

export interface ProcessWakeRuntimeOptions {
  readonly concurrency: number
  readonly context: RuntimeScheduleWakeDriverContext
  readonly intervalMs: number
  readonly now?: () => Date
}

function cloneState(state: ProcessWakeState, patch: Partial<ProcessWakeState>): ProcessWakeState {
  return {
    active: patch.active ?? state.active,
    closed: patch.closed ?? state.closed,
    closing: patch.closing ?? state.closing,
    dispatched: patch.dispatched ?? state.dispatched,
    occurrenceMinute: patch.occurrenceMinute ?? state.occurrenceMinute,
    queued: patch.queued ?? state.queued,
    schedules: patch.schedules ?? state.schedules,
    started: patch.started ?? state.started,
  }
}

function floorUTCMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
    ),
  )
}

function occurrenceKey(input: RuntimeScheduleWake): string {
  return `${input.scheduleId}:${input.scheduledAt.getTime()}`
}

function reportError(
  context: RuntimeScheduleWakeDriverContext,
  error: unknown,
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      context.reportError(error)
    } catch {}
  })
}

function wrapBoundary<A>(operation: () => A): Effect.Effect<A, ProcessWakeBoundaryError> {
  return Effect.try({
    try: operation,
    catch: (cause) => new ProcessWakeBoundaryError({ cause }),
  })
}

export const makeProcessWakeRuntime = Effect.fn("ScheduleProcessDriver.make")(function* (
  options: ProcessWakeRuntimeOptions,
) {
  const clock = yield* Clock.Clock
  const operationLock = yield* Semaphore.make(1)
  const queue = yield* Queue.bounded<RuntimeScheduleWake, Cause.Done>(options.concurrency)
  const enqueueFibers = yield* FiberSet.make()
  const scannerFibers = yield* FiberSet.make()
  const workerFibers = yield* FiberSet.make()
  const state = yield* Ref.make<ProcessWakeState>({
    active: new Set(),
    closed: false,
    closing: false,
    dispatched: new Set(),
    queued: new Map(),
    schedules: new Map(),
    started: false,
  })

  const currentDate = options.now
    ? wrapBoundary(() => options.now!())
    : Effect.map(clock.currentTimeMillis, (millis) => new Date(millis))

  const claimOccurrence = Effect.fn("ScheduleProcessDriver.claim")(function* (
    input: RuntimeScheduleWake,
  ): Effect.fn.Return<boolean, ProcessWakeBoundaryError> {
    const key = occurrenceKey(input)
    const snapshot = yield* Ref.get(state)
    const queuedOccurrence = snapshot.queued.get(key)
    if (!queuedOccurrence) return false

    const schedule = snapshot.schedules.get(input.scheduleId)
    const due = schedule?.enabled
      ? yield* wrapBoundary(() => isRuntimeScheduleDue(schedule, input.scheduledAt))
      : false

    return yield* Ref.modify(state, (current) => {
      if (
        current.queued.get(key) !== queuedOccurrence ||
        current.schedules.get(input.scheduleId) !== schedule
      ) {
        return [undefined, current] as const
      }

      const queued = new Map(current.queued)
      queued.delete(key)
      if (!due) {
        const dispatched = new Set(current.dispatched)
        if (current.occurrenceMinute === input.scheduledAt.getTime() && !current.active.has(key)) {
          dispatched.delete(input.scheduleId)
        }
        return [false, cloneState(current, { dispatched, queued })] as const
      }

      const active = new Set(current.active)
      active.add(key)
      return [true, cloneState(current, { active, queued })] as const
    }).pipe(
      Effect.flatMap((claimed) =>
        claimed === undefined ? claimOccurrence(input) : Effect.succeed(claimed),
      ),
    )
  })

  const dispatch = Effect.fn("ScheduleProcessDriver.dispatch")(function* (
    input: RuntimeScheduleWake,
  ) {
    const key = occurrenceKey(input)
    const claimed = yield* claimOccurrence(input).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (value) => ({ value }),
      }),
    )
    if ("error" in claimed) {
      yield* reportError(options.context, claimed.error.cause)
      return
    }
    if (!claimed.value) return

    yield* Effect.tryPromise({
      try: () => Promise.resolve(options.context.wake(input)),
      catch: (cause) => new ProcessWakeBoundaryError({ cause }),
    }).pipe(
      Effect.catchTag("ProcessWakeBoundaryError", (error) =>
        reportError(options.context, error.cause),
      ),
      Effect.ensuring(
        Ref.update(state, (current) => {
          const active = new Set(current.active)
          active.delete(key)
          return cloneState(current, { active })
        }),
      ),
    )
  })

  const worker = Effect.forever(Effect.flatMap(Queue.take(queue), dispatch)).pipe(
    Effect.catchCauseIf(Cause.isDone, () => Effect.void),
  )

  yield* Effect.forEach(
    Array.from({ length: options.concurrency }),
    () => FiberSet.run(workerFibers, worker, { startImmediately: true }),
    { discard: true },
  )

  const scanUnlocked = Effect.fn("ScheduleProcessDriver.scan")(function* () {
    const scheduledAt = floorUTCMinute(yield* currentDate)
    const snapshot = yield* Ref.get(state)
    const dueIds: string[] = []
    for (const schedule of snapshot.schedules.values()) {
      if (!schedule.enabled) continue
      const result = yield* wrapBoundary(() => isRuntimeScheduleDue(schedule, scheduledAt)).pipe(
        Effect.match({
          onFailure: (error) => ({ error }),
          onSuccess: (due) => ({ due }),
        }),
      )
      if ("error" in result) {
        yield* reportError(options.context, result.error.cause)
      } else if (result.due) {
        dueIds.push(schedule.id)
      }
    }

    const occurrences = yield* Ref.modify(state, (current) => {
      if (current.closed || current.closing) return [[] as RuntimeScheduleWake[], current] as const
      const dispatched =
        current.occurrenceMinute === scheduledAt.getTime()
          ? new Set(current.dispatched)
          : new Set<string>()
      const queued = new Map(current.queued)
      const occurrences: RuntimeScheduleWake[] = []
      for (const scheduleId of dueIds) {
        const input = { scheduleId, scheduledAt }
        const key = occurrenceKey(input)
        if (dispatched.has(scheduleId) || queued.has(key) || current.active.has(key)) continue
        dispatched.add(scheduleId)
        queued.set(key, input)
        occurrences.push(input)
      }
      return [
        occurrences,
        cloneState(current, {
          dispatched,
          occurrenceMinute: scheduledAt.getTime(),
          queued,
        }),
      ] as const
    })

    return occurrences
  })

  const enqueue = (occurrences: readonly RuntimeScheduleWake[]) =>
    occurrences.length === 0
      ? Effect.void
      : FiberSet.run(enqueueFibers, Queue.offerAll(queue, occurrences), { startImmediately: true })
  const scan = operationLock.withPermits(1)(Effect.flatMap(scanUnlocked(), enqueue))
  const scanIteration = scan.pipe(
    Effect.catchTag("ProcessWakeBoundaryError", (error) =>
      reportError(options.context, error.cause),
    ),
  )
  const scanLoop = Effect.forever(
    Effect.andThen(
      clock.sleep(Duration.millis(options.intervalMs)),
      FiberSet.run(scannerFibers, scanIteration, { startImmediately: true }),
    ),
  )

  const reconcile = Effect.fn("ScheduleProcessDriver.reconcile")(function* (
    records: readonly RuntimeScheduleRecord[],
  ) {
    yield* operationLock.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(state)
        if (snapshot.closed) {
          return yield* Effect.fail(
            new ProcessWakeBoundaryError({
              cause: new Error("Process Schedule Wake Driver is closed."),
            }),
          )
        }

        const scheduledAt = floorUTCMinute(yield* currentDate)
        for (const record of records) {
          if (!record.enabled) continue
          yield* wrapBoundary(() => isRuntimeScheduleDue(record, scheduledAt))
        }

        const schedules = new Map(records.map((record) => [record.id, { ...record }]))
        const startScanner = yield* Ref.modify(state, (current) => {
          const dispatched = new Set(current.dispatched)
          const queued = new Map(current.queued)
          for (const [key, input] of queued) {
            const schedule = schedules.get(input.scheduleId)
            if (schedule?.enabled && isRuntimeScheduleDue(schedule, input.scheduledAt)) continue
            queued.delete(key)
            if (
              current.occurrenceMinute === input.scheduledAt.getTime() &&
              !current.active.has(key)
            ) {
              dispatched.delete(input.scheduleId)
            }
          }
          return [
            !current.started,
            cloneState(current, {
              dispatched,
              queued,
              schedules,
            }),
          ] as const
        })

        if (!snapshot.closing) {
          yield* Effect.flatMap(scanUnlocked(), enqueue)
          if (startScanner) {
            yield* FiberSet.run(scannerFibers, scanLoop, { startImmediately: true })
            yield* Ref.update(state, current => cloneState(current, { started: true }))
          }
        }
      }),
    )
  })

  const close = Effect.fn("ScheduleProcessDriver.close")(function* () {
    const shouldClose = yield* operationLock.withPermits(1)(
      Ref.modify(
        state,
        (current) =>
          [
            !current.closed && !current.closing,
            cloneState(current, { closing: true, queued: new Map() }),
          ] as const,
      ),
    )
    if (!shouldClose) return

    yield* FiberSet.clear(scannerFibers)
    yield* FiberSet.awaitEmpty(enqueueFibers)
    yield* Queue.end(queue)
    yield* FiberSet.awaitEmpty(workerFibers)
    yield* Ref.update(state, (current) => cloneState(current, { closed: true }))
  })

  return { close: close(), reconcile }
})
