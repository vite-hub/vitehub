import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, vi } from "vitest"

import { makeProcessWakeRuntime, unwrapProcessWakeExit } from "../src/internal/process-wake-runtime.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleWake } from "../src/types.ts"

function record(): RuntimeScheduleRecord {
  const epoch = new Date(0)
  return {
    createdAt: epoch,
    cron: "* * * * *",
    enabled: true,
    id: "daily",
    target: "report",
    updatedAt: epoch,
  }
}

it("drives process wake scanning with TestClock", async () => {
  const wakes: RuntimeScheduleWake[] = []
  let resolveFirst!: () => void
  let resolveSecond!: () => void
  const firstWake = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  const secondWake = new Promise<void>((resolve) => {
    resolveSecond = resolve
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const testClock = yield* TestClock.make()
        const runtime = yield* makeProcessWakeRuntime({
          concurrency: 1,
          context: {
            reportError: vi.fn(),
            async wake(input) {
              wakes.push(input)
              if (wakes.length === 1) resolveFirst()
              if (wakes.length === 2) resolveSecond()
            },
          },
          intervalMs: 60_000,
        }).pipe(Effect.provideService(Clock.Clock, testClock))

        yield* runtime.reconcile([record()])
        yield* Effect.promise(() => firstWake)
        yield* Effect.yieldNow
        yield* testClock.adjust(60_000)
        yield* Effect.promise(() => secondWake)
        yield* runtime.close
      }),
    ),
  )

  expect(wakes).toEqual([
    { scheduleId: "daily", scheduledAt: new Date(0) },
    { scheduleId: "daily", scheduledAt: new Date(60_000) },
  ])
})

it("starts polling after an initial scan failure is retried", async () => {
  const wakes: RuntimeScheduleWake[] = []
  let calls = 0
  let now = new Date(0)
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const testClock = yield* TestClock.make()
        const runtime = yield* makeProcessWakeRuntime({
          concurrency: 1,
          context: {
            reportError: vi.fn(),
            async wake(input) {
              wakes.push(input)
            },
          },
          intervalMs: 60_000,
          now() {
            calls += 1
            if (calls === 2) throw new Error("transient clock failure")
            return now
          },
        }).pipe(Effect.provideService(Clock.Clock, testClock))

        const failure = yield* Effect.flip(runtime.reconcile([record()]))
        expect(failure.cause).toEqual(new Error("transient clock failure"))

        yield* runtime.reconcile([record()])
        now = new Date(60_000)
        yield* testClock.adjust(60_000)
        yield* Effect.yieldNow
        yield* runtime.close
      }),
    ),
  )

  expect(wakes.some(wake => wake.scheduledAt.getTime() === 60_000)).toBe(true)
})

it("preserves defect identity without exposing Effect FiberFailure", async () => {
  const defect = new Error("process wake defect")
  const failure = await unwrapProcessWakeExit(Effect.runPromiseExit(Effect.die(defect))).then(
    () => undefined,
    error => error,
  )

  expect(failure).toBe(defect)
  expect(failure).not.toMatchObject({ name: "FiberFailure" })
})

it("preserves interruption identity without exposing Effect FiberFailure", async () => {
  const reason = new Error("caller canceled process wake")
  const controller = new AbortController()
  const result = unwrapProcessWakeExit(
    Effect.runPromiseExit(Effect.never, { signal: controller.signal }),
    controller.signal,
  ).then(
    () => undefined,
    error => error,
  )
  controller.abort(reason)
  const failure = await result

  expect(failure).toBe(reason)
  expect(failure).not.toMatchObject({ name: "FiberFailure" })
})
