import { Clock, Context, Duration, Effect, Layer, ManagedRuntime, Scheduler } from "effect"

import { makeProcessWakeRuntime, ProcessWakeBoundaryError } from "../internal/process-wake-runtime.ts"

import type { ProcessWakeRuntime } from "../internal/process-wake-runtime.ts"
import type { RuntimeScheduleWakeDriverFactory } from "./driver.ts"

export interface ProcessScheduleWakeDriverOptions {
  concurrency?: number
  intervalMs?: number
  now?: () => Date
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONCURRENCY = 1

function validateOptions(options: ProcessScheduleWakeDriverOptions): { concurrency: number, intervalMs: number } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > DEFAULT_INTERVAL_MS) {
    throw new TypeError("Process Schedule Wake Driver intervalMs must be a positive number no greater than 60000.")
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Process Schedule Wake Driver concurrency must be a positive integer.")
  }
  return { concurrency, intervalMs }
}

interface BoundaryResult<A> {
  readonly error?: ProcessWakeBoundaryError
  readonly value?: A
}

class ProcessWakeRuntimeService extends Context.Service<ProcessWakeRuntimeService, ProcessWakeRuntime>()("@vite-hub/schedule/ProcessWakeRuntime") {}

function createProcessClock(): Clock.Clock {
  const currentTimeMillisUnsafe = () => Date.now()
  const currentTimeNanosUnsafe = () => BigInt(currentTimeMillisUnsafe()) * 1_000_000n
  return {
    currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
    currentTimeMillisUnsafe,
    currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
    currentTimeNanosUnsafe,
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

async function unwrapBoundary<A>(promise: Promise<BoundaryResult<A>>): Promise<A> {
  const result = await promise
  if (result.error) throw result.error.cause
  return result.value as A
}

export function createProcessScheduleWakeDriver(options: ProcessScheduleWakeDriverOptions = {}): RuntimeScheduleWakeDriverFactory {
  return (context) => {
    const { concurrency, intervalMs } = validateOptions(options)
    const ProcessWakeRuntimeLive = Layer.effect(
      ProcessWakeRuntimeService,
      makeProcessWakeRuntime({ concurrency, context, intervalMs, now: options.now }),
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
      return unwrapBoundary(runtime.runPromise(effect.pipe(
        Effect.match({
          onFailure: error => ({ error }),
          onSuccess: value => ({ value }),
        }),
      )))
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
      reconcile(records) {
        if (closed) return Promise.reject(new Error("Process Schedule Wake Driver is closed."))
        return run(Effect.flatMap(ProcessWakeRuntimeService, service => service.reconcile(records)))
      },
    }
  }
}
