import { Cause, Clock, Context, Data, Duration, Effect, Exit, FiberSet, Layer, ManagedRuntime, Queue, Ref, Scheduler, Semaphore } from "effect"

import { isScheduleDue } from "../runtime/due.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

import type { ScheduleCronRecord } from "../runtime/due.ts"
import type { ProcessScheduleRuntimeOptions } from "../runtime/process.ts"

/** One Static Schedule that the process checks each minute. */
export type ProcessScheduleEntry = ScheduleCronRecord

/** One due occurrence of a Static Schedule. */
export interface ProcessScheduleWake {
  scheduleId: string
  scheduledAt: Date
}

export interface ProcessWakeContext {
  /** Scheduled time of the Schedule's newest run, or `undefined` when it has no run. The runtime uses it to catch up missed minutes. */
  latestScheduledAt?(scheduleId: string): Promise<Date | undefined>
  reportError(error: unknown): void
  wake(input: ProcessScheduleWake): Promise<void>
}

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
  readonly queued: Map<string, ProcessScheduleWake>
  readonly scannedThrough?: number
  readonly schedules: Map<string, ProcessScheduleEntry>
  readonly started: boolean
}

export interface ProcessWakeRuntime {
  readonly close: Effect.Effect<void>
  readonly reconcile: (
    records: readonly ProcessScheduleEntry[],
  ) => Effect.Effect<void, ProcessWakeBoundaryError>
}

export interface ProcessWakeRuntimeOptions {
  /** How far back the driver dispatches due minutes that no scan checked. `0` checks only the current minute. */
  readonly catchUpMs: number
  readonly concurrency: number
  readonly context: ProcessWakeContext
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

function occurrenceKey(input: ProcessScheduleWake): string {
  return `${input.scheduleId}:${input.scheduledAt.getTime()}`
}

function reportError(
  context: ProcessWakeContext,
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
  const queue = yield* Queue.bounded<ProcessScheduleWake, Cause.Done>(options.concurrency)
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
    input: ProcessScheduleWake,
  ): Effect.fn.Return<boolean, ProcessWakeBoundaryError> {
    const key = occurrenceKey(input)
    const snapshot = yield* Ref.get(state)
    const queuedOccurrence = snapshot.queued.get(key)
    if (!queuedOccurrence) return false

    const schedule = snapshot.schedules.get(input.scheduleId)
    const due = schedule
      ? yield* wrapBoundary(() => isScheduleDue(schedule, input.scheduledAt))
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
    input: ProcessScheduleWake,
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
    schedules: Iterable<ProcessScheduleEntry>,
    first: number,
    last: number,
  ) {
    const due: ProcessScheduleWake[] = []
    for (const schedule of schedules) {
      for (let minute = first; minute <= last; minute += minuteMs) {
        const scheduledAt = new Date(minute)
        const result = yield* wrapBoundary(() => isScheduleDue(schedule, scheduledAt)).pipe(
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
  const queueOccurrences = (due: readonly ProcessScheduleWake[], currentMinute: number) =>
    Ref.modify(state, (current) => {
      if (current.closed || current.closing) return [[] as ProcessScheduleWake[], current] as const
      // A wall-clock correction can move the process into an earlier minute. Do not
      // reset the per-minute deduplication state, or that minute may run twice when
      // the clock moves forward again.
      if (current.occurrenceMinute !== undefined && currentMinute < current.occurrenceMinute) {
        return [[] as ProcessScheduleWake[], current] as const
      }
      const dispatched =
        current.occurrenceMinute === currentMinute
          ? new Set(current.dispatched)
          : new Set<string>()
      const queued = new Map(current.queued)
      const occurrences: ProcessScheduleWake[] = []
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
    schedules: readonly ProcessScheduleEntry[],
  ) {
    const latestScheduledAt = options.context.latestScheduledAt
    if (!latestScheduledAt || options.catchUpMs <= 0) return [] as ProcessScheduleWake[]
    const currentMinute = floorUTCMinute(yield* currentDate).getTime()
    const due: ProcessScheduleWake[] = []
    for (const schedule of schedules) {
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

  const enqueue = (occurrences: readonly ProcessScheduleWake[]) =>
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
    records: readonly ProcessScheduleEntry[],
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
          yield* wrapBoundary(() => isScheduleDue(record, scheduledAt))
        }

        const schedules = new Map(records.map((record) => [record.id, { ...record }]))
        const startScanner = yield* Ref.modify(state, (current) => {
          const dispatched = new Set(current.dispatched)
          const queued = new Map(current.queued)
          for (const [key, input] of queued) {
            const schedule = schedules.get(input.scheduleId)
            if (schedule && isScheduleDue(schedule, input.scheduledAt)) continue
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

export type ProcessWakeDriverOptions = Pick<ProcessScheduleRuntimeOptions, "catchUpMs" | "concurrency" | "intervalMs" | "now">

export interface ProcessWakeDriver {
  close(): Promise<void>
  reconcile(entries: readonly ProcessScheduleEntry[]): Promise<void>
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONCURRENCY = 1
const DEFAULT_CATCH_UP_MS = 60 * 60_000

function validateDriverOptions(options: ProcessWakeDriverOptions): { catchUpMs: number, concurrency: number, intervalMs: number } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS
  if (!Number.isFinite(catchUpMs) || catchUpMs < 0) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0024({ message: "Process Schedule Runtime catchUpMs must be a finite number of zero or more." })
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > DEFAULT_INTERVAL_MS) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0024({ message: "Process Schedule Runtime intervalMs must be a positive number no greater than 60000." })
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0025({ message: "Process Schedule Runtime concurrency must be a positive integer." })
  }
  return { catchUpMs, concurrency, intervalMs }
}

class ProcessWakeRuntimeService extends Context.Service<ProcessWakeRuntimeService, ProcessWakeRuntime>()("@vite-hub/schedule/ProcessWakeRuntime") {}

function createProcessClock(): Clock.Clock {
  const currentTimeMillisUnsafe = () => Date.now()
  const currentTimeNanosUnsafe = () => BigInt(currentTimeMillisUnsafe()) * 1_000_000n
  const monotonicTimeNanosUnsafe = () => process.hrtime.bigint()
  return {
    currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
    currentTimeMillisUnsafe,
    currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
    currentTimeNanosUnsafe,
    monotonicTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
    monotonicTimeNanosUnsafe,
    sleep(duration) {
      return Effect.callback((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
        timer.unref?.()
        return Effect.sync(() => clearTimeout(timer))
      })
    },
  }
}

function createProcessScheduler(): Scheduler.Scheduler {
  return new Scheduler.MixedScheduler("async", (run) => {
    let canceled = false
    queueMicrotask(() => {
      if (!canceled) run()
    })
    return () => { canceled = true }
  })
}

/**
 * Creates the in-process minute scanner. `reconcile()` replaces the checked Schedules and starts the scanner on the
 * first call. `close()` stops the scanner and waits for active wakes. Timers do not keep the process alive.
 */
export function createProcessWakeDriver(options: ProcessWakeDriverOptions, context: ProcessWakeContext): ProcessWakeDriver {
  const { catchUpMs, concurrency, intervalMs } = validateDriverOptions(options)
  const ProcessWakeRuntimeLive = Layer.effect(
    ProcessWakeRuntimeService,
    makeProcessWakeRuntime({ catchUpMs, concurrency, context, intervalMs, now: options.now }),
  ).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Clock.Clock, createProcessClock()),
      Layer.succeed(Scheduler.Scheduler, createProcessScheduler()),
    )),
  )
  const runtime = ManagedRuntime.make(ProcessWakeRuntimeLive)
  let closePromise: Promise<void> | undefined
  let closed = false

  function run<A>(effect: Effect.Effect<A, ProcessWakeBoundaryError, ProcessWakeRuntimeService>): Promise<A> {
    return unwrapProcessWakeExit(runtime.runPromiseExit(effect))
  }

  return {
    close() {
      if (closePromise) return closePromise
      closePromise = run(Effect.flatMap(ProcessWakeRuntimeService, service => service.close))
        .then(() => {
          closed = true
          return runtime.dispose()
        })
      return closePromise
    },
    reconcile(entries) {
      if (closed) return Promise.reject(scheduleErrorDiagnostics.SCHEDULE_R0026({ message: "Process Schedule Runtime is closed." }))
      return run(Effect.flatMap(ProcessWakeRuntimeService, service => service.reconcile(entries)))
    },
  }
}
