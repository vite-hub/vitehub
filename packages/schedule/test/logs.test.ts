import { setEvlogBridge } from "@vite-hub/internal/runtime/request-log"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { scheduleIdempotencyKey } from "../src/runtime/date.ts"
import { resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryStartedScheduleStore, installStartedSchedules, runStartedSchedules } from "../src/runtime/started.ts"
import { executeSchedule } from "../src/runtime/execute.ts"
import { executeMatchingStaticSchedules, logScheduleRuntimeError, markLoggedScheduleError, normalizeScheduleRuntimeError } from "../src/runtime/static.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"
import { startSchedule } from "../src/started.ts"

import type { ScheduleDefinitionRegistry } from "../src/types.ts"

interface LoggedEvent { fields: Record<string, unknown>, info: string[], warn: string[], error: unknown[] }

function evlogStub(): LoggedEvent[] {
  const events: LoggedEvent[] = []
  setEvlogBridge({
    createLogger(fields) {
      const event: LoggedEvent = { fields, info: [], warn: [], error: [] }
      events.push(event)
      return {
        info: (message) => { event.info.push(message) },
        warn: (message) => { event.warn.push(message) },
        error: (error) => { event.error.push(error) },
        emit: () => fields,
      }
    },
  })
  return events
}

afterEach(() => {
  setEvlogBridge(undefined)
  resetScheduleRuntime()
  vi.restoreAllMocks()
})

describe("Schedule runs in logs", () => {
  it("emits one event for each cron run, with its outcome", async () => {
    const events = evlogStub()
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const failure = new Error("Gmail returned 502")
    const registry: ScheduleDefinitionRegistry = {
      "digest": async () => ({ cron: "0 8 * * *", handler: async () => {} }),
      "sync-inbox": async () => ({ cron: "0 8 * * *", handler: async () => { throw failure } }),
    }

    await expect(executeMatchingStaticSchedules({ cron: "0 8 * * *", registry, scheduledAt: new Date("2026-11-17T08:00:00Z") })).rejects.toBe(failure)

    const digest = events.find(event => (event.fields.schedule as { name: string }).name === "digest")
    const sync = events.find(event => (event.fields.schedule as { name: string }).name === "sync-inbox")
    expect(events).toHaveLength(2)
    expect(digest).toEqual({
      fields: {
        action: "schedule",
        message: "Schedule run succeeded",
        schedule: { name: "digest", source: "static", scheduledAt: "2026-11-17T08:00:00.000Z", ms: expect.any(Number), outcome: "success" },
      },
      info: ["Schedule run succeeded"],
      warn: [],
      error: [],
    })
    expect(sync).toEqual({
      fields: {
        action: "schedule",
        message: "Schedule run failed",
        schedule: { name: "sync-inbox", source: "static", scheduledAt: "2026-11-17T08:00:00.000Z", ms: expect.any(Number), outcome: "failure" },
      },
      info: [],
      warn: [],
      error: [failure],
    })
    // The run event has the failure, so the console line is not printed again.
    expect(console).not.toHaveBeenCalled()
  })

  it("emits an event for a started Schedule run that fails, which the run history also records", async () => {
    const events = evlogStub()
    const failing = defineSchedule({ handler: () => { throw new Error("boom") } })
    installStartedSchedules({ registry: { reminder: async () => failing }, store: createMemoryStartedScheduleStore() })
    const [, schedule] = await startSchedule("reminder", { at: "2026-11-08T09:00:00Z" })
    const scheduledAt = new Date("2026-11-08T09:00:00Z")

    await runStartedSchedules({ id: "tick", idempotencyKey: scheduleIdempotencyKey("vitehub/started-schedules", scheduledAt), scheduledAt, waitUntil: () => {} })

    expect(events).toHaveLength(1)
    expect(events[0]!.fields).toEqual({
      action: "schedule",
      message: "Schedule run failed",
      schedule: {
        name: "reminder",
        id: schedule!.id,
        runId: expect.stringMatching(/^srun_started_/),
        source: "started",
        scheduledAt: "2026-11-08T09:00:00.000Z",
        attempt: 1,
        ms: expect.any(Number),
        outcome: "failure",
      },
    })
    expect(events[0]!.error).toEqual([expect.objectContaining({ message: "boom" })])
  })

  it("runs and logs to the console as before without evlog", async () => {
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const finished: string[] = []
    const registry: ScheduleDefinitionRegistry = {
      digest: async () => ({ cron: "0 8 * * *", handler: async () => { finished.push("digest") } }),
      broken: async () => ({ cron: "0 8 * * *", handler: async () => { throw new Error("sync failed") } }),
    }

    await expect(executeMatchingStaticSchedules({ cron: "0 8 * * *", registry })).rejects.toThrow("sync failed")

    expect(finished).toEqual(["digest"])
    expect(console).toHaveBeenCalledOnce()
    expect(console.mock.calls[0]?.[0]).toBe(`[vitehub:schedule] Schedule "broken" failed (cron "0 8 * * *").`)
  })

  it("logs a thrown string once, and keeps evlog's drain alive with waitUntil", async () => {
    const events = evlogStub()
    const console = vi.spyOn(globalThis.console, "error").mockImplementation(() => {})
    const kept: unknown[] = []
    const registry: ScheduleDefinitionRegistry = {
      // eslint-disable-next-line no-throw-literal -- An app can throw a string, and it must be logged once.
      broken: async () => ({ cron: "0 8 * * *", handler: async () => { throw "quota exceeded" } }),
    }
    setEvlogBridge({ createLogger: fields => ({ info() {}, warn() {}, error() {}, emit: () => { events.push({ fields, info: [], warn: [], error: [] }); return fields } }), drain: () => {} })

    await expect(executeMatchingStaticSchedules({ cron: "0 8 * * *", registry, waitUntil: promise => kept.push(promise) })).rejects.toBe("quota exceeded")

    expect(events).toHaveLength(1)
    expect(kept).toHaveLength(1)
    expect(console).not.toHaveBeenCalled()
  })

  it("reports a handler that finished and a run store that failed as two events", async () => {
    const events = evlogStub()
    const store = createMemoryScheduleRunStore()
    const updateRun = store.updateRun.bind(store)
    vi.spyOn(store, "updateRun").mockImplementation(async (id, patch) => {
      if (patch.status === "succeeded") throw Object.assign(new Error("KV write to srun_direct_digest failed"), { code: "KV_OPERATION_FAILED" })
      return updateRun(id, patch)
    })

    await expect(executeSchedule({ captureHandlerFailure: true, definition: { handler: () => "sent" }, runStore: store, scheduleId: "digest", scheduledAt: new Date("2026-11-17T08:00:00Z"), target: "digest" })).rejects.toMatchObject({ code: "KV_OPERATION_FAILED" })
    expect(events.map(event => event.fields)).toEqual([
      { action: "schedule", message: "Schedule run succeeded", schedule: expect.objectContaining({ name: "digest", outcome: "success" }) },
      { action: "schedule", message: "Schedule could not record a finished run", schedule: { op: "record-run", name: "digest", runId: expect.any(String), code: "KV_OPERATION_FAILED" } },
    ])
  })

  it("logs a started Schedule that keeps failing at each tick once, until the cause changes", async () => {
    const events = evlogStub()
    let load: ScheduleDefinitionRegistry[string] = async () => defineSchedule({ handler: () => {} })
    installStartedSchedules({ registry: { reminder: () => load() }, store: createMemoryStartedScheduleStore() })
    await startSchedule("reminder", { at: "2026-11-08T09:00:00Z" })
    load = async () => { throw Object.assign(new Error("The module failed to load."), { code: "ERR_MODULE_NOT_FOUND" }) }
    const tick = (minute: number) => {
      const scheduledAt = new Date(Date.UTC(2026, 10, 8, 9, minute))
      return runStartedSchedules({ id: "tick", idempotencyKey: scheduleIdempotencyKey("vitehub/started-schedules", scheduledAt), scheduledAt, waitUntil: () => {} })
    }

    for (const minute of [0, 1, 2]) await tick(minute)
    expect(events.map(event => event.fields.schedule)).toEqual([{ op: "started", name: "reminder", id: expect.any(String), code: "ERR_MODULE_NOT_FOUND" }])

    load = async () => { throw new TypeError("registry entry is not a function") }
    await tick(3)
    expect(events).toHaveLength(2)
  })

  it("does not log a runtime failure again when a run event has it", () => {
    const events = evlogStub()
    const failure = new Error("sync failed")

    logScheduleRuntimeError(markLoggedScheduleError(failure), normalizeScheduleRuntimeError(failure))
    const marked = markLoggedScheduleError("quota exceeded")
    logScheduleRuntimeError(marked, normalizeScheduleRuntimeError(marked))
    expect(events).toHaveLength(0)

    logScheduleRuntimeError(new Error("lease store down"), normalizeScheduleRuntimeError(new Error("lease store down")))
    expect(events).toHaveLength(1)
  })
})
