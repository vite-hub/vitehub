import { Cause, Clock, Data, Duration, Effect, Exit, FiberSet, Queue, Ref, Semaphore } from "effect"

import { isRuntimeScheduleDue } from "../runtime/due.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleWake } from "../types.ts"
import type { RuntimeScheduleWakeDriverContext } from "../runtime/driver.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

export class ProcessWakeBoundaryError extends Data.TaggedError("ProcessWakeBoundaryError")<{
  readonly cause: unknown
}> {}

function interruptionError(signal?: AbortSignal): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason
  const error = scheduleErrorDiagnostics.SCHEDULE_R0001({ message: "[vitehub] Process Schedule Wake Driver operation was interrupted." })
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
  readonly scannedThrough?: number
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
  /** How far back the driver dispatches due minutes that no scan checked. `0` checks only the current minute. */
  readonly catchUpMs: number
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
    scannedThrough: patch.scannedThrough ?? state.scannedThrough,
    schedules: patch.schedules ?? state.schedules,
    started: patch.started ?? state.started,
  }
}

const minuteMs = 60_000

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

  /** Due occurrences of `schedules` from `first` through `last`, oldest first. */
  const dueOccurrences = Effect.fn("ScheduleProcessDriver.due")(function* (
    schedules: Iterable<RuntimeScheduleRecord>,
    first: number,
    last: number,
  ) {
    const due: RuntimeScheduleWake[] = []
    for (const schedule of schedules) {
      if (!schedule.enabled) continue
      for (let minute = first; minute <= last; minute += minuteMs) {
        const scheduledAt = new Date(minute)
        const result = yield* wrapBoundary(() => isRuntimeScheduleDue(schedule, scheduledAt)).pipe(
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: (isDue) => ({ isDue }),
          }),
        )
        if ("error" in result) {
          yield* reportError(options.context, result.error.cause)
          break
        }
        if (result.isDue) due.push({ scheduleId: schedule.id, scheduledAt })
      }
    }
    return due.sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())
  })

  /** Queues occurrences that are not queued or running yet. The current minute dispatches each Schedule once. */
  const queueOccurrences = (due: readonly RuntimeScheduleWake[], currentMinute: number) =>
    Ref.modify(state, (current) => {
      if (current.closed || current.closing) return [[] as RuntimeScheduleWake[], current] as const
      // A wall-clock correction can move the process into an earlier minute. Do not
      // reset the per-minute deduplication state, or that minute may run twice when
      // the clock moves forward again.
      if (current.occurrenceMinute !== undefined && currentMinute < current.occurrenceMinute) {
        return [[] as RuntimeScheduleWake[], current] as const
      }
      const dispatched =
        current.occurrenceMinute === currentMinute
          ? new Set(current.dispatched)
          : new Set<string>()
      const queued = new Map(current.queued)
      const occurrences: RuntimeScheduleWake[] = []
      for (const input of due) {
        const key = occurrenceKey(input)
        if (queued.has(key) || current.active.has(key)) continue
        if (input.scheduledAt.getTime() === currentMinute) {
          if (dispatched.has(input.scheduleId)) continue
          dispatched.add(input.scheduleId)
        }
        queued.set(key, input)
        occurrences.push(input)
      }
      return [
        occurrences,
        cloneState(current, {
          dispatched,
          occurrenceMinute: currentMinute,
          queued,
          scannedThrough: Math.max(current.scannedThrough ?? currentMinute, currentMinute),
        }),
      ] as const
    })

  const scanUnlocked = Effect.fn("ScheduleProcessDriver.scan")(function* () {
    const currentMinute = floorUTCMinute(yield* currentDate).getTime()
    const snapshot = yield* Ref.get(state)
    // A late timer can skip a minute. Check every minute after the previous scan.
    const first = snapshot.scannedThrough === undefined
      ? currentMinute
      : Math.min(currentMinute, Math.max(snapshot.scannedThrough + minuteMs, currentMinute - options.catchUpMs))
    const due = yield* dueOccurrences(snapshot.schedules.values(), first, currentMinute)
    return yield* queueOccurrences(due, currentMinute)
  })

  // After a restart, dispatch the minutes that no process checked: those after each Schedule's
  // latest run, within `catchUpMs`. Run ids are deterministic, so a minute that already ran does not run again.
  const catchUpUnlocked = Effect.fn("ScheduleProcessDriver.catchUp")(function* (
    schedules: readonly RuntimeScheduleRecord[],
  ) {
    const latestScheduledAt = options.context.latestScheduledAt
    if (!latestScheduledAt || options.catchUpMs <= 0) return [] as RuntimeScheduleWake[]
    const currentMinute = floorUTCMinute(yield* currentDate).getTime()
    const due: RuntimeScheduleWake[] = []
    for (const schedule of schedules) {
      if (!schedule.enabled) continue
      const latest = yield* Effect.tryPromise({
        try: () => Promise.resolve(latestScheduledAt(schedule.id)),
        catch: (cause) => new ProcessWakeBoundaryError({ cause }),
      }).pipe(Effect.catchTag("ProcessWakeBoundaryError", (error) =>
        Effect.as(reportError(options.context, error.cause), undefined),
      ))
      if (!latest) continue
      const first = Math.max(floorUTCMinute(latest).getTime() + minuteMs, currentMinute - options.catchUpMs)
      due.push(...yield* dueOccurrences([schedule], first, currentMinute - minuteMs))
    }
    return yield* queueOccurrences(due.sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime()), currentMinute)
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
              cause: scheduleErrorDiagnostics.SCHEDULE_R0002({ message: "Process Schedule Wake Driver is closed." }),
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
          if (startScanner) yield* Effect.flatMap(catchUpUnlocked(records), enqueue)
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
