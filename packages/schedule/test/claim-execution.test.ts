import { createMemoryLeaseStore } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { createOccurrenceClaims, occurrenceDoneKey } from "../src/runtime/claims.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { createMemoryStartedScheduleStore, installStartedSchedules, runStartedSchedules } from "../src/runtime/started.ts"
import { resetScheduleRuntime, setScheduleOccurrenceClaims, setScheduleRunStore } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

const controllers: Array<{ close(): Promise<void> }> = []
const scheduledAt = new Date("2026-11-09T08:00:00.000Z")

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.close()))
  resetScheduleRuntime()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each(["static", "started-once", "started-cron"] as const)("%s pre-handler recovery", (source) => {
  it.each(["getRun", "createRun", "createAttempt", "updateRun", "listAttempts", "updateAttempt"] as const)("retries after %s fails without publishing completion", async (operation) => {
    vi.useFakeTimers({ now: new Date("2026-11-09T08:00:10.000Z") })
    const leases = createMemoryLeaseStore()
    const store = createMemoryScheduleRunStore()
    const startedStore = createMemoryStartedScheduleStore()
    const handler = vi.fn()
    const onError = vi.fn()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const runId = `srun_${source === "static" ? "static" : "started"}_daily_${scheduledAt.toISOString()}`
    if (operation === "listAttempts" || operation === "updateAttempt") {
      await store.createRun({ attemptCount: 1, createdAt: scheduledAt, id: runId, scheduleId: "daily", scheduledAt, status: "running", target: "daily", updatedAt: scheduledAt })
      await store.createAttempt({ createdAt: scheduledAt, id: "stopped", runId, startedAt: scheduledAt, status: "running", updatedAt: scheduledAt })
    }
    const failure = new Error(`${operation} unavailable`)
    vi.spyOn(store, operation).mockRejectedValueOnce(failure)

    async function tick() {
      await runStartedSchedules({ id: "tick", idempotencyKey: "tick", scheduledAt: new Date(), waitUntil: () => {} })
    }

    if (source === "static") {
      controllers.push(await installProcessScheduleRuntime({
        catchUpMs: 60_000,
        intervalMs: 60_000,
        leases,
        onError,
        registry: { daily: async () => defineSchedule({ cron: "0 8 * * *", handler }) },
        scheduleRunStore: store,
      }))
      await vi.advanceTimersByTimeAsync(0)
      expect(onError).toHaveBeenCalledWith(failure)
    }
    else {
      setScheduleRunStore(store)
      setScheduleOccurrenceClaims(createOccurrenceClaims({ doneTtlMs: 240_000, leases, reportError: onError, ttlMs: 60_000 }))
      installStartedSchedules({ registry: { daily: async () => defineSchedule({ handler }) }, store: startedStore })
      await startedStore.put({
        ...(source === "started-once" ? { at: scheduledAt } : { cron: "0 8 * * *" }),
        createdAt: new Date("2026-11-09T07:00:00.000Z"),
        id: "daily",
        name: "daily",
      })
      await tick()
    }

    expect(handler).not.toHaveBeenCalled()
    expect((await leases.get(occurrenceDoneKey(runId)))[1]).toBeNull()
    if (source !== "static") expect(await startedStore.get("daily")).toBeDefined()

    await vi.advanceTimersByTimeAsync(60_000)
    if (source !== "static") await tick()
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await store.getRun(runId))?.status).toBe("succeeded")
    expect((await leases.get(occurrenceDoneKey(runId)))[1]).not.toBeNull()
    if (source === "started-once") expect(await startedStore.get("daily")).toBeUndefined()
  })

  it("keeps an actual handler failure final", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T08:00:10.000Z") })
    const leases = createMemoryLeaseStore()
    const handler = vi.fn(() => { throw new Error("handler failed") })
    const store = createMemoryScheduleRunStore()
    const onError = vi.fn()
    if (source === "static") {
      controllers.push(await installProcessScheduleRuntime({
        catchUpMs: 60_000,
        intervalMs: 60_000,
        leases,
        onError,
        registry: { daily: async () => defineSchedule({ cron: "0 8 * * *", handler }) },
        scheduleRunStore: store,
      }))
      await vi.advanceTimersByTimeAsync(60_000)
    }
    else {
      const startedStore = createMemoryStartedScheduleStore()
      setScheduleRunStore(store)
      setScheduleOccurrenceClaims(createOccurrenceClaims({ doneTtlMs: 240_000, leases, reportError: onError, ttlMs: 60_000 }))
      installStartedSchedules({ registry: { daily: async () => defineSchedule({ handler }) }, store: startedStore })
      await startedStore.put({ ...(source === "started-once" ? { at: scheduledAt } : { cron: "0 8 * * *" }), createdAt: new Date("2026-11-09T07:00:00.000Z"), id: "daily", name: "daily" })
      for (let index = 0; index < 2; index++) {
        await runStartedSchedules({ id: "tick", idempotencyKey: "tick", scheduledAt, waitUntil: () => {} })
      }
    }
    const runId = `srun_${source === "static" ? "static" : "started"}_daily_${scheduledAt.toISOString()}`
    expect(handler).toHaveBeenCalledTimes(1)
    expect((await store.getRun(runId))?.status).toBe("failed")
    expect((await leases.get(occurrenceDoneKey(runId)))[1]).not.toBeNull()
  })
})
