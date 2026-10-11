import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { deserializeResponse, serializeResponse, ViteHubError } from "@vite-hub/runtime"
import { defineSchedule, defineScheduleTarget, schedules, type ScheduleKVStorage } from "../src/index.ts"
import { createKVRuntimeScheduleStore, createKVScheduleRunStore, createMemoryScheduleRunStore, createScheduleRun, executeRuntimeSchedule, executeStaticSchedule, runSchedule } from "../src/runtime.ts"
import { loadScheduleDefinition, resetScheduleRuntime, setScheduleRunStore, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"

function createTestKVStore(): ScheduleKVStorage {
  const data = new Map<string, unknown>()

  return {
    async del(key) {
      data.delete(key)
    },
    async get(key) {
      return (data.get(key) ?? null) as never
    },
    async has(key) {
      return data.has(key)
    },
    async keys(base = "") {
      return [...data.keys()].filter(key => key.startsWith(base)).sort()
    },
    async set(key, value) {
      data.set(key, value)
    },
  }
}

function createDelayedHasKVStore(): ScheduleKVStorage & { releaseHas: () => void } {
  const store = createTestKVStore()
  let releaseHas: (() => void) | undefined
  return {
    ...store,
    async has(key) {
      if (!releaseHas) {
        await new Promise<void>(resolve => { releaseHas = resolve })
      }
      return await store.has(key)
    },
    releaseHas() {
      releaseHas?.()
    },
  }
}

function createDelayedGetKVStore(): ScheduleKVStorage & { releaseGet: () => void } {
  const store = createTestKVStore()
  let reads = 0
  let releaseGet!: () => void
  const gate = new Promise<void>(resolve => { releaseGet = resolve })
  return {
    ...store,
    async get(key) {
      if (key.includes("/schedule-runs/") || key.includes("/schedule-run-attempts/")) {
        reads++
        if (reads <= 2) await gate
      }
      return await store.get(key)
    },
    releaseGet,
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  resetScheduleRuntime()
})

describe("Runtime Schedule helper", () => {
  it("creates and reads recurring cron schedules for runtime-eligible targets", async () => {
    setScheduleRuntimeRegistry({
      "daily-report": async () => ({
        default: {
          cron: "0 9 * * *",
          handler: async () => {},
          options: { allowRuntimeSchedules: true },
        },
      }),
    })

    const created = await schedules.dynamic.create({
      cron: "30 8 * * 1-5",
      id: "schedule-1",
      target: "daily-report",
      timeZone: "Europe/Copenhagen",
    })

    expect(created).toMatchObject({
      cron: "30 8 * * 1-5",
      enabled: true,
      id: "schedule-1",
      target: "daily-report",
      timeZone: "Europe/Copenhagen",
    })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)
    expect(await schedules.get("schedule-1")).toEqual(created)
    expect(await schedules.list()).toEqual([created])
  })

  it("stores Runtime Schedule input as replaceable snapshots", async () => {
    setScheduleRuntimeRegistry({
      report: async () => defineScheduleTarget({ handler: async () => {} }),
    })
    const input = { prompt: "Morning report", settings: { concise: true } }

    const created = await schedules.dynamic.create({
      cron: "0 9 * * *",
      id: "schedule-1",
      input,
      target: "report",
    })
    input.settings.concise = false
    expect(created.input).toEqual({ prompt: "Morning report", settings: { concise: true } })

    const read = await schedules.get("schedule-1")
    ;(read!.input as typeof input).settings.concise = false
    expect((await schedules.get("schedule-1"))?.input).toEqual({ prompt: "Morning report", settings: { concise: true } })

    const replacement = { prompt: "Evening report", settings: { concise: false } }
    const updated = await schedules.dynamic.update("schedule-1", { input: replacement })
    replacement.prompt = "mutated"
    expect(updated.input).toEqual({ prompt: "Evening report", settings: { concise: false } })

    await schedules.dynamic.update("schedule-1", { cron: "0 18 * * *" })
    expect((await schedules.get("schedule-1"))?.input).toEqual({ prompt: "Evening report", settings: { concise: false } })

    const cleared = await schedules.dynamic.update("schedule-1", { input: undefined })
    expect(cleared.input).toBeUndefined()
    expect((await schedules.get("schedule-1"))?.input).toBeUndefined()
  })

  it("updates, disables, enables, and deletes schedules through the same store", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
      cleanup: async () => ({
        cron: "0 0 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    const created = await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const updated = await schedules.dynamic.update("schedule-1", { cron: "15 10 * * *", target: "cleanup", timeZone: "Europe/Copenhagen" })
    expect(updated).toMatchObject({ cron: "15 10 * * *", enabled: true, id: "schedule-1", target: "cleanup", timeZone: "Europe/Copenhagen" })
    expect(updated.createdAt).toEqual(created.createdAt)
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    expect(await schedules.dynamic.update("schedule-1", { enabled: false })).toMatchObject({ enabled: false, timeZone: "Europe/Copenhagen" })
    expect(await schedules.dynamic.update("schedule-1", { timeZone: "UTC" })).toMatchObject({ timeZone: "UTC" })
    expect(await schedules.disable("schedule-1")).toMatchObject({ enabled: false, timeZone: "UTC" })
    expect(await schedules.enable("schedule-1")).toMatchObject({ enabled: true })
    expect(await schedules.delete("schedule-1")).toBe(true)
    expect(await schedules.get("schedule-1")).toBeUndefined()
  })

  it("fails clearly for duplicate runtime schedule ids", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.dynamic.create({ cron: "0 10 * * *", id: "schedule-1", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_ALREADY_EXISTS",
    })
  })

  it("fails clearly for invalid cron strings", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.dynamic.create({ cron: "99 9 * * *", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_CRON",
    })
  })

  it("fails clearly for invalid Runtime Schedule time zones", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "report", timeZone: "Not/A_Zone" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "report", timeZone: "+01:00" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "report", timeZone: "PST" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })

    const linked = await schedules.dynamic.create({ cron: "0 9 * * *", id: "linked-zone", target: "report", timeZone: "Asia/Kolkata" })
    expect(linked).toMatchObject({ timeZone: "Asia/Kolkata" })
    await expect(schedules.dynamic.update("linked-zone", { timeZone: "US/Eastern" })).resolves.toMatchObject({ timeZone: "US/Eastern" })
    await expect(schedules.dynamic.update("linked-zone", { timeZone: "Etc/UTC" })).resolves.toMatchObject({ timeZone: "Etc/UTC" })
    await expect(schedules.dynamic.update("linked-zone", { timeZone: "CET" })).resolves.toMatchObject({ timeZone: "CET" })
    await expect(schedules.dynamic.update("linked-zone", { timeZone: "EST5EDT" })).resolves.toMatchObject({ timeZone: "EST5EDT" })
    await expect(schedules.dynamic.update("linked-zone", { timeZone: "PST8PDT" })).resolves.toMatchObject({ timeZone: "PST8PDT" })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.dynamic.update("schedule-1", { timeZone: "Not/A_Zone" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.dynamic.update("schedule-1", { timeZone: "-05:30" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
  })

  it("rejects unknown Runtime Schedule create and update keys", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "report", timezone: "UTC" } as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
      message: "Runtime Schedule input is invalid.",
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.dynamic.update("schedule-1", { timezone: "UTC" } as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
      message: "Runtime Schedule input is invalid.",
    })
  })

  it("rejects explicitly empty ids", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", id: "", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ID",
    })
    await expect(schedules.dynamic.create({ cron: "0 9 * * *", id: 123 as never, target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ID",
    })
  })

  it("rejects non-boolean enabled flags", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", enabled: "false" as never, target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.dynamic.update("schedule-1", { enabled: "false" as never })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })
  })

  it("rejects non-object runtime schedule create and update inputs", async () => {
    await expect(schedules.dynamic.create(null as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
    await expect(schedules.dynamic.create("bad" as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
    await expect(schedules.dynamic.update("schedule-1", null as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
  })

  it("rejects non-object runtime schedule execute options", async () => {
    await expect(executeRuntimeSchedule(null as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
    await expect(executeRuntimeSchedule(123 as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
  })

  it("fails clearly for unknown targets", async () => {
    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "missing" })).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_FOUND",
    })
  })

  it("fails clearly for schedule targets that did not opt in", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
      }),
    })

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
    })
  })

  it("preserves newer in-flight registry loads when stale loads finish", async () => {
    let finishOld: (() => void) | undefined
    let finishNew: (() => void) | undefined
    let newLoadCount = 0

    setScheduleRuntimeRegistry({
      report: async () => {
        await new Promise<void>(resolve => { finishOld = resolve })
        return { cron: "0 9 * * *", handler: async () => {} }
      },
    })
    const oldLoad = loadScheduleDefinition("report")
    await Promise.resolve()

    setScheduleRuntimeRegistry({
      report: async () => {
        newLoadCount++
        await new Promise<void>(resolve => { finishNew = resolve })
        return { cron: "0 10 * * *", handler: async () => {} }
      },
    })
    const newLoad = loadScheduleDefinition("report")
    await Promise.resolve()
    finishOld?.()
    await expect(oldLoad).resolves.toBeUndefined()

    const sharedLoad = loadScheduleDefinition("report")
    await Promise.resolve()
    finishNew?.()
    await Promise.all([newLoad, sharedLoad])

    expect(newLoadCount).toBe(1)
  })

  it("does not return stale in-flight registry loads to waiters after registry replacement", async () => {
    let finishOld: (() => void) | undefined

    setScheduleRuntimeRegistry({
      report: async () => {
        await new Promise<void>(resolve => { finishOld = resolve })
        return { cron: "0 9 * * *", handler: async () => {} }
      },
    })
    void loadScheduleDefinition("report")
    await Promise.resolve()
    const staleWaiter = loadScheduleDefinition("report")

    setScheduleRuntimeRegistry({
      report: async () => ({ cron: "0 10 * * *", handler: async () => {} }),
    })
    finishOld?.()

    await expect(staleWaiter).resolves.toBeUndefined()
    await expect(loadScheduleDefinition("report")).resolves.toMatchObject({ cron: "0 10 * * *" })
  })

  it("ignores inherited runtime registry entries", async () => {
    const inheritedRegistry = {}
    Object.defineProperty(inheritedRegistry, "__proto__", {
      value: async () => ({ cron: "0 9 * * *", handler: async () => {}, options: { allowRuntimeSchedules: true } }),
    })
    const registry = Object.create(inheritedRegistry) as Record<string, () => unknown>
    registry.report = async () => ({ cron: "0 9 * * *", handler: async () => {}, options: { allowRuntimeSchedules: true } })
    setScheduleRuntimeRegistry(registry as Parameters<typeof setScheduleRuntimeRegistry>[0])

    await expect(schedules.dynamic.create({ cron: "0 9 * * *", target: "__proto__" })).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_FOUND",
    })
  })

  it("returns early for recursive loads of the same runtime target", async () => {
    setScheduleRuntimeRegistry({
      report: async () => {
        expect(await loadScheduleDefinition("report")).toBeUndefined()
        return { cron: "0 9 * * *", handler: async () => {} }
      },
    })

    await expect(loadScheduleDefinition("report")).resolves.toMatchObject({
      cron: "0 9 * * *",
    })
  })

  it("fails clearly when updating an unknown schedule", async () => {
    await expect(schedules.dynamic.update("missing", { enabled: false })).rejects.toBeInstanceOf(ViteHubError)
    await expect(schedules.dynamic.update("missing", { enabled: false })).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    })
  })
})

describe("KV Runtime Schedule Store", () => {
  it("matches the RuntimeScheduleStore create, list, update, get, and delete contract", async () => {
    const store = createKVRuntimeScheduleStore({ kvStore: createTestKVStore(), prefix: "tests/schedules" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const updatedAt = new Date("2026-05-23T09:01:00.000Z")

    const created = await store.create({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      input: { prompt: "Daily report", settings: { concise: true } },
      target: "daily/report",
      timeZone: "Europe/Copenhagen",
      updatedAt,
    })

    expect(created).toEqual({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      input: { prompt: "Daily report", settings: { concise: true } },
      target: "daily/report",
      timeZone: "Europe/Copenhagen",
      updatedAt,
    })
    expect((await store.get("schedule/1"))?.createdAt).toBeInstanceOf(Date)
    expect(await store.list()).toEqual([created])

    created.cron = "mutated"
    ;(created.input as { settings: { concise: boolean } }).settings.concise = false
    expect((await store.get("schedule/1"))?.cron).toBe("0 9 * * *")
    expect((await store.get("schedule/1"))?.input).toEqual({ prompt: "Daily report", settings: { concise: true } })

    const changedAt = new Date("2026-05-23T10:00:00.000Z")
    await expect(store.update("missing", { enabled: false, updatedAt: changedAt })).resolves.toBeUndefined()
    const replacement = { prompt: "Updated report", settings: { concise: false } }
    const updated = await store.update("schedule/1", { cron: "30 10 * * *", enabled: false, input: replacement, timeZone: "Asia/Bangkok", updatedAt: changedAt })
    replacement.prompt = "mutated"
    expect(updated).toMatchObject({ cron: "30 10 * * *", enabled: false, id: "schedule/1", input: { prompt: "Updated report", settings: { concise: false } }, timeZone: "Asia/Bangkok" })
    expect(updated?.createdAt).toEqual(createdAt)
    expect(updated?.updatedAt).toEqual(changedAt)
    expect((await store.get("schedule/1"))?.timeZone).toBe("Asia/Bangkok")

    const unchanged = await store.update("schedule/1", { cron: undefined, target: undefined, updatedAt: changedAt } as never)
    expect(unchanged).toMatchObject({ cron: "30 10 * * *", target: "daily/report" })

    const cleared = await store.update("schedule/1", { input: undefined, updatedAt: changedAt })
    expect(cleared?.input).toBeUndefined()
    expect((await store.get("schedule/1"))?.input).toBeUndefined()

    await expect(store.create({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt,
    })).rejects.toMatchObject({ code: "SCHEDULE_ALREADY_EXISTS" })

    await expect(store.delete("missing")).resolves.toBe(false)
    await expect(store.delete("schedule/1")).resolves.toBe(true)
    await expect(store.get("schedule/1")).resolves.toBeUndefined()
  })

  it("serializes concurrent creates for the same KV runtime schedule key", async () => {
    const kvStore = createDelayedHasKVStore()
    const store = createKVRuntimeScheduleStore({ kvStore, prefix: "tests/schedules-lock" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const record = {
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt: createdAt,
    }

    const first = store.create(record)
    const second = store.create(record)
    await flushAsyncWork()
    kvStore.releaseHas()

    const results = await Promise.allSettled([first, second])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    await expect(store.get("schedule/1")).resolves.toMatchObject({ id: "schedule/1" })
  })

  it("keeps KV runtime schedule deletes serialized with concurrent updates", async () => {
    const kvStore = createTestKVStore()
    const originalSet = kvStore.set.bind(kvStore)
    let releaseUpdateSet: (() => void) | undefined
    let pauseUpdateSet = false
    kvStore.set = async (key, value) => {
      if (pauseUpdateSet && key.includes("runtime-schedules")) {
        await new Promise<void>(resolve => { releaseUpdateSet = resolve })
      }
      await originalSet(key, value)
    }

    const store = createKVRuntimeScheduleStore({ kvStore, prefix: "tests/schedules-delete-lock" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    await store.create({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt: createdAt,
    })

    pauseUpdateSet = true
    const updating = store.update("schedule/1", {
      enabled: false,
      updatedAt: new Date("2026-05-23T10:00:00.000Z"),
    })
    await flushAsyncWork()

    const deleting = store.delete("schedule/1")
    await flushAsyncWork()
    releaseUpdateSet?.()

    await expect(updating).resolves.toMatchObject({ enabled: false })
    await expect(deleting).resolves.toBe(true)
    await expect(store.get("schedule/1")).resolves.toBeUndefined()
  })
})

describe("Schedule Run bookkeeping", () => {
  it("uses direct schedule run ids when source is omitted", async () => {
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")

    await expect(createScheduleRun({
      scheduleId: "daily-report",
      scheduledAt,
      target: "daily-report",
    })).resolves.toMatchObject({
      id: "srun_direct_daily-report_2026-05-23T09:00:00.000Z",
    })
  })

  it("records a run and one successful attempt for a Runtime Schedule", async () => {
    const seen: unknown[] = []
    setScheduleRuntimeRegistry({
      report: async () => defineScheduleTarget<{ prompt: string }>({
        handler: async context => seen.push(context),
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", input: { prompt: "Daily report" }, target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const run = await schedules.run("schedule-1", { scheduledAt })
    const attempts = await schedules.listAttempts(run.id)

    expect(run).toMatchObject({
      attemptCount: 1,
      id: "srun_runtime_schedule-1_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-1",
      scheduledAt,
      status: "succeeded",
      target: "report",
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ runId: run.id, status: "succeeded" })
    expect(seen).toEqual([
      expect.objectContaining({
        attemptId: attempts[0]!.id,
        id: run.id,
        input: { prompt: "Daily report" },
        runId: run.id,
        scheduleId: "schedule-1",
        scheduledAt,
        target: "report",
      }),
    ])
  })

  it("fails clearly for invalid scheduledAt dates", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

    await expect(schedules.run("schedule-1", { scheduledAt: new Date("bad") })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
    })
    await expect(executeStaticSchedule({
      cron: "0 9 * * *",
      definition: { cron: "0 9 * * *", handler: async () => {} },
      name: "report",
      scheduledAt: new Date("bad"),
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
    })
  })

  it("blocks execution when a persisted Runtime Schedule target opts out", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
      }),
    })

    await expect(schedules.run("schedule-1")).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
    })
  })

  it("blocks execution when a persisted Runtime Schedule is disabled", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await schedules.run("schedule-1", { scheduledAt })
    await schedules.disable("schedule-1")

    await expect(schedules.run("schedule-1", { scheduledAt })).rejects.toMatchObject({
      code: "SCHEDULE_DISABLED",
    })
    await schedules.enable("schedule-1")
    await expect(schedules.run("schedule-1", { scheduledAt })).resolves.toEqual(first)
  })

  it("returns an existing run before revalidating a Runtime Schedule", async () => {
    const calls: string[] = []
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          calls.push("run")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await schedules.run("schedule-1", { scheduledAt })
    await schedules.delete("schedule-1")

    await expect(schedules.run("schedule-1", { scheduledAt })).resolves.toEqual(first)
    expect(calls).toEqual(["run"])
  })

  it("uses the same bookkeeping path for static provider-triggered schedules", async () => {
    const scheduledAt = new Date("2026-05-23T10:00:00.000Z")
    const run = await executeStaticSchedule({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler: async () => {},
      },
      name: "static-report",
      scheduledAt,
    })

    expect(run).toMatchObject({
      attemptCount: 1,
      id: "srun_static_static-report_2026-05-23T10:00:00.000Z",
      scheduleId: "static-report",
      scheduledAt,
      status: "succeeded",
      target: "static-report",
    })
    expect(await schedules.getRun(run.id)).toEqual(run)
    expect(await schedules.listAttempts(run.id)).toHaveLength(1)
  })

  it("dedupes repeated due events and does not retry or overlap by default", async () => {
    let calls = 0
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          calls += 1
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await schedules.run("schedule-1", { scheduledAt })
    const second = await schedules.run("schedule-1", { scheduledAt })

    expect(second).toEqual(first)
    expect(calls).toBe(1)
    expect(await schedules.listAttempts(first.id)).toHaveLength(1)
  })

  it("keeps run ids distinct for schedule ids with the same sanitized form", async () => {
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await executeStaticSchedule({
      cron: "0 9 * * *",
      definition: { cron: "0 9 * * *", handler: async () => {} },
      name: "daily/report",
      scheduledAt,
    })
    const second = await executeStaticSchedule({
      cron: "0 9 * * *",
      definition: { cron: "0 9 * * *", handler: async () => {} },
      name: "daily-report",
      scheduledAt,
    })

    expect(first.id).toBe("srun_static_daily%2Freport_2026-05-23T09:00:00.000Z")
    expect(second.id).toBe("srun_static_daily-report_2026-05-23T09:00:00.000Z")
  })

  it("keeps static and Runtime Schedule runs distinct for shared ids", async () => {
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    let runtimeCalls = 0
    let staticCalls = 0
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          runtimeCalls++
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.dynamic.create({ cron: "0 9 * * *", id: "shared-id", target: "report" })

    const runtimeRun = await schedules.run("shared-id", { scheduledAt })
    const staticRun = await executeStaticSchedule({
      cron: "0 9 * * *",
      definition: {
        cron: "0 9 * * *",
        handler: async () => {
          staticCalls++
        },
      },
      name: "shared-id",
      scheduledAt,
    })

    expect(runtimeRun.id).toBe("srun_runtime_shared-id_2026-05-23T09:00:00.000Z")
    expect(staticRun.id).toBe("srun_static_shared-id_2026-05-23T09:00:00.000Z")
    expect(runtimeCalls).toBe(1)
    expect(staticCalls).toBe(1)
  })

  it("reloads an existing run when duplicate creation wins the race", async () => {
    const store = createMemoryScheduleRunStore()
    let calls = 0
    setScheduleRunStore({
      ...store,
      async createRun(run) {
        const created = await store.createRun(run)
        throw new Error(`Schedule Run already exists: ${created.id}`)
      },
    })
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          calls += 1
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const run = await schedules.run("schedule-1", { scheduledAt })

    expect(run).toMatchObject({
      id: "srun_runtime_schedule-1_2026-05-23T09:00:00.000Z",
      status: "pending",
    })
    expect(calls).toBe(0)
  })

  it("records failed handler diagnostics on the run and attempt", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          throw new TypeError("boom")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    await expect(schedules.run("schedule-1", { scheduledAt })).rejects.toThrow("boom")

    const [run] = await schedules.listRuns()
    expect(run).toMatchObject({
      error: { message: "boom", name: "TypeError" },
      status: "failed",
    })
    const [attempt] = await schedules.listAttempts(run!.id)
    expect(attempt).toMatchObject({
      error: { message: "boom", name: "TypeError" },
      status: "failed",
    })
  })

  it("isolates stored run errors from returned object mutation", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          throw new TypeError("boom")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.dynamic.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.run("schedule-1", { scheduledAt: new Date("2026-05-23T09:00:00.000Z") })).rejects.toThrow("boom")
    const [run] = await schedules.listRuns()
    run!.error!.message = "mutated"

    expect((await schedules.getRun(run!.id))!.error).toMatchObject({ message: "boom" })
  })
})

describe("Manual Schedule runs", () => {
  it("runs a manual Static Schedule Definition with a run id that cron runs cannot use", async () => {
    const calls: unknown[] = []
    const run = await runSchedule("sync", {
      registry: {
        sync: async () => ({
          default: defineSchedule("*/5 * * * *", (context) => {
            calls.push(context.id)
            return { synced: 3 }
          }, { manual: true }),
        }),
      },
    })

    expect(run).toMatchObject({
      attemptCount: 1,
      scheduleId: "sync",
      status: "succeeded",
      target: "sync",
    })
    expect(run.id).toMatch(new RegExp(`^srun_manual_sync_${run.scheduledAt.toISOString()}_.+$`))
    expect(calls).toEqual([run.id])
    expect(await schedules.getRun(run.id)).toEqual(run)
  })

  it("creates distinct runs for concurrent manual invocations in one millisecond", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"))
    let calls = 0
    const registry = {
      sync: async () => defineSchedule("*/5 * * * *", () => {
        calls++
        return { synced: calls }
      }, { manual: true }),
    }

    const runs = await Promise.all([runSchedule("sync", { registry }), runSchedule("sync", { registry })])

    expect(new Set(runs.map(run => run.id)).size).toBe(2)
    expect(calls).toBe(2)
    expect(await schedules.listRuns()).toHaveLength(2)
  })

  it("uses the installed runtime registry when no registry is passed", async () => {
    setScheduleRuntimeRegistry({
      sync: async () => defineSchedule({ cron: "0 9 * * *", handler: () => {}, manual: true }),
    })

    await expect(runSchedule("sync")).resolves.toMatchObject({ status: "succeeded" })
  })

  it("runs cross-realm handlers from installed and supplied registries", async () => {
    const calls: string[] = []
    const handler = runInNewContext('() => calls.push("cross-realm")', { calls }) as () => void
    const definition = { cron: "0 9 * * *", handler, options: { manual: true } }
    const registry = { report: async () => ({ default: definition }) }
    expect(handler).not.toBeInstanceOf(Function)
    setScheduleRuntimeRegistry(registry)

    await runSchedule("report")
    await runSchedule("report", { registry })
    expect(calls).toEqual(["cross-realm", "cross-realm"])
  })

  it("rejects inherited definitions from the installed runtime registry", async () => {
    const inherited = {
      default: defineSchedule("0 9 * * *", () => {}, { manual: true }),
    }
    setScheduleRuntimeRegistry({
      inherited: async () => Object.create(inherited),
    })

    await expect(runSchedule("inherited")).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    expect(await schedules.listRuns()).toEqual([])
  })

  it("rejects inherited manual schedule definitions", async () => {
    const inherited = {
      default: defineSchedule("0 9 * * *", () => {}, { manual: true }),
    }
    const registry = {
      inherited: async () => Object.create(inherited),
    }

    await expect(runSchedule("inherited", { registry })).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    expect(await schedules.listRuns()).toEqual([])
  })

  it("rejects definitions that do not allow manual runs", async () => {
    const registry = {
      cron: async () => defineSchedule("0 9 * * *", () => {}),
      disabled: async () => defineSchedule("0 9 * * *", () => {}, { manual: false }),
      target: async () => defineScheduleTarget({ handler: () => {} }),
    }

    await expect(runSchedule("cron", { registry })).rejects.toMatchObject({ code: "SCHEDULE_MANUAL_RUN_DISABLED" })
    await expect(runSchedule("disabled", { registry })).rejects.toMatchObject({ code: "SCHEDULE_MANUAL_RUN_DISABLED" })
    await expect(runSchedule("target", { registry })).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    await expect(runSchedule("missing", { registry })).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    await expect(runSchedule("toString", { registry })).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    await expect(runSchedule("", { registry })).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    expect(await schedules.listRuns()).toEqual([])
  })

  it("resolves with the failed run when the handler fails", async () => {
    const run = await runSchedule("sync", {
      registry: {
        sync: async () => defineSchedule("0 9 * * *", () => {
          throw new TypeError("mailbox unavailable")
        }, { manual: true }),
      },
    })

    expect(run).toMatchObject({
      error: { message: "mailbox unavailable", name: "TypeError" },
      status: "failed",
    })
    expect(await schedules.listAttempts(run.id)).toEqual([expect.objectContaining({ status: "failed" })])
  })
})

describe("KV Schedule Run Store", () => {
  it("reads only attempts for the requested run and sees another store's writes", async () => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    const createdAt = new Date("2026-05-23T09:00:00Z")
    for (let index = 0; index < 200; index++) {
      await store.createAttempt({ id: `opaque/attempt%_${index}`, runId: index < 2 ? "target/run%" : `other_${index}`,
        createdAt, startedAt: createdAt, updatedAt: createdAt, status: "running" })
    }
    const get = vi.spyOn(kvStore, "get")
    expect((await store.listAttempts("target/run%")).map(attempt => attempt.id)).toEqual(["opaque/attempt%_0", "opaque/attempt%_1"])
    expect(get).toHaveBeenCalledTimes(2)
    await createKVScheduleRunStore({ kvStore }).createAttempt({ id: "external/attempt%", runId: "target/run%",
      createdAt, startedAt: createdAt, updatedAt: createdAt, status: "running" })
    get.mockClear()
    expect(await store.listAttempts("target/run%")).toHaveLength(3)
    expect(get).toHaveBeenCalledTimes(3)
    get.mockClear()
    expect(await store.listAttempts("target/run")).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it.each([true, false])("preserves legacy attempts when index writes are available: %s", async (indexAvailable) => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore, prefix: "attempt-tests/custom" })
    const createdAt = new Date("2026-05-23T09:00:00Z")
    for (let index = 0; index < 40; index++) {
      await store.createAttempt({ id: `legacy/opaque%_${index}`, runId: index < 2 ? "target" : "other",
        createdAt, startedAt: createdAt, updatedAt: createdAt, status: "running" })
    }
    for (const key of await kvStore.keys("attempt-tests/custom/schedule-run-attempt-index/")) await kvStore.del(key)
    if (!indexAvailable) {
      const set = kvStore.set.bind(kvStore)
      vi.spyOn(kvStore, "set").mockImplementation(async (key, value) => {
        if (key.includes("/schedule-run-attempt-index/")) throw new Error("index unavailable")
        return set(key, value)
      })
    }
    const get = vi.spyOn(kvStore, "get")
    expect(await store.listAttempts("target")).toHaveLength(2)
    expect(get).toHaveBeenCalledTimes(40)
    get.mockClear()
    expect(await store.listAttempts("target")).toHaveLength(2)
    expect(get).toHaveBeenCalledTimes(indexAvailable ? 2 : 40)
    expect(await store.getAttempt("legacy/opaque%_0")).toMatchObject({ runId: "target" })
  })

  it("limits provider reads to the newest matching indexed run keys", async () => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    for (let index = 0; index < 100; index++) {
      const scheduledAt = new Date(Date.UTC(2026, 0, 1, 0, index))
      for (const scheduleId of ["digest_with_underscore", "other"]) {
        await store.createRun({
          id: `srun_runtime_${encodeURIComponent(scheduleId)}_${scheduledAt.toISOString()}`,
          scheduleId, target: "report", scheduledAt, createdAt: scheduledAt, updatedAt: scheduledAt,
          status: "pending", attemptCount: 0,
        })
      }
    }
    const get = vi.spyOn(kvStore, "get")
    const runs = await store.listRuns({ scheduleId: "digest_with_underscore", runtimeOnly: true, limit: 10 })
    expect(runs).toHaveLength(10)
    expect(get).toHaveBeenCalledTimes(10)
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-01-01T01:39:00.000Z")
    expect(runs.every(run => run.scheduleId === "digest_with_underscore")).toBe(true)
  })

  it.each([true, false])("preserves newest opaque fallback history when index writes are available: %s", async (indexAvailable) => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    for (let index = 0; index < 30; index++) {
      const scheduledAt = new Date(Date.UTC(2026, 0, 1, 0, index))
      for (const scheduleId of ["actual", "other"]) {
        await store.createRun({ id: `srun_runtime_${scheduleId}_opaque%_${index}`, scheduleId, target: "report", scheduledAt,
          createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
      }
    }
    for (const key of await kvStore.keys("vitehub:schedule/schedule-run-index")) await kvStore.del(key)
    if (!indexAvailable) {
      const set = kvStore.set.bind(kvStore)
      vi.spyOn(kvStore, "set").mockImplementation(async (key, value) => {
        if (key.includes("/schedule-run-index/")) throw new Error("index unavailable")
        return set(key, value)
      })
    }
    const get = vi.spyOn(kvStore, "get")
    const latest = await store.listRuns({ scheduleId: "actual", limit: 1 })
    expect(latest[0]?.id).toBe("srun_runtime_actual_opaque%_29")
    expect(get).toHaveBeenCalledTimes(60)
    get.mockClear()
    const other = await store.listRuns({ scheduleId: "other", runtimeOnly: true, limit: 10 })
    expect(other).toHaveLength(10)
    expect(other[0]?.id).toBe("srun_runtime_other_opaque%_29")
    expect(get).toHaveBeenCalledTimes(indexAvailable ? 10 : 60)
    expect(await store.getRun("srun_runtime_actual_opaque%_29")).toEqual(latest[0])
  })

  it("reports incomplete history when the unindexed fallback exceeds its safety bound", async () => {
    const kvStore = createTestKVStore()
    const set = kvStore.set.bind(kvStore)
    vi.spyOn(kvStore, "set").mockImplementation(async (key, value) => {
      if (key.includes("/schedule-run-index/")) throw new Error("index unavailable")
      return set(key, value)
    })
    const store = createKVScheduleRunStore({ kvStore })
    const get = vi.spyOn(kvStore, "get")
    const scheduledAt = new Date("2026-01-01T00:00:00.000Z")
    for (let index = 0; index < 1001; index++) {
      await store.createRun({ id: `legacy_${index}`, scheduleId: "legacy", target: "report", scheduledAt,
        createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
    }
    for (const options of [{ limit: 1 }, { scheduleId: "legacy" }, { runtimeOnly: true }]) {
      await expect(store.listRuns(options)).rejects.toMatchObject({
        code: "SCHEDULE_HISTORY_INCOMPLETE",
        name: "ScheduleHistoryIncompleteError",
      })
    }
    expect(get).not.toHaveBeenCalled()
  })

  it("parses each indexed key once for a multi-Schedule history batch", async () => {
    const store = createKVScheduleRunStore({ kvStore: createTestKVStore() })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    for (const scheduleId of ["alpha", "beta", "gamma"]) {
      await store.createRun({ id: `srun_runtime_${scheduleId}`, scheduleId, target: "report", scheduledAt,
        createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
    }
    const decode = vi.spyOn(globalThis, "decodeURIComponent")
    try {
      const results = await store.listRunsBatch!(["alpha", "beta", "gamma"].map(scheduleId => ({ scheduleId, runtimeOnly: true, limit: 1 })))
      expect(results.map(runs => runs[0]?.scheduleId)).toEqual(["alpha", "beta", "gamma"])
      expect(decode).toHaveBeenCalledTimes(12)
    }
    finally {
      decode.mockRestore()
    }
  })

  it.each([true, false])("groups legacy run payloads once per batch when indexes are available: %s", async indexAvailable => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    const response = await serializeResponse(new Response("retained legacy payload"))
    for (const scheduleId of ["alpha", "beta", "gamma", "delta"]) {
      for (let index = 0; index < 8; index++) {
        const scheduledAt = new Date(Date.UTC(2026, 0, 1, 0, index))
        await store.createRun({ id: `${index % 2 ? "srun_runtime_" : "manual_"}${scheduleId}_opaque%_${index}`,
          scheduleId, target: "report", scheduledAt, createdAt: scheduledAt, updatedAt: scheduledAt,
          status: "failed", attemptCount: 1, error: { name: "Error", message: "retained" }, response })
      }
    }
    for (const key of await kvStore.keys("vitehub:schedule/schedule-run-index")) await kvStore.del(key)
    if (!indexAvailable) {
      const set = kvStore.set.bind(kvStore)
      vi.spyOn(kvStore, "set").mockImplementation(async (key, value) => {
        if (key.includes("/schedule-run-index/")) throw new Error("index unavailable")
        return set(key, value)
      })
    }
    const get = vi.spyOn(kvStore, "get")
    const clone = vi.spyOn(globalThis, "structuredClone")
    try {
      const results = await store.listRunsBatch!([
        ...["alpha", "beta", "gamma", "delta"].map(scheduleId => ({ scheduleId, limit: 1 })),
        { scheduleId: "alpha", runtimeOnly: true, limit: 1 },
        { runtimeOnly: true, limit: 3 }, {}, { scheduleId: "alpha" }, { runtimeOnly: true }, { limit: 0 },
      ])
      expect(results.slice(0, 4).map(runs => runs[0]?.scheduleId)).toEqual(["alpha", "beta", "gamma", "delta"])
      expect(results[4]?.[0]?.id).toBe("srun_runtime_alpha_opaque%_7")
      expect(results[5]).toHaveLength(3)
      expect(results[5]?.every(run => run.id.startsWith("srun_runtime_") && run.scheduledAt.getUTCMinutes() === 7)).toBe(true)
      expect(results.slice(6).map(runs => runs.length)).toEqual([32, 8, 16, 0])
      expect(get).toHaveBeenCalledTimes(32)
      // Retained payloads are decoded once, then copied only for matching output records.
      expect(clone.mock.calls.length).toBeLessThanOrEqual(32 + results.flat().length)
      results[0]![0]!.error!.message = "changed"
      results[0]![0]!.scheduledAt.setUTCFullYear(2000)
      expect(results[4]?.[0]?.error?.message).toBe("retained")
      expect(results[4]?.[0]?.scheduledAt.getUTCFullYear()).toBe(2026)
      get.mockClear()
      expect((await store.listRunsBatch!([{ scheduleId: "alpha", limit: 1 }]))[0]?.[0]?.id).toBe("srun_runtime_alpha_opaque%_7")
      expect(get).toHaveBeenCalledTimes(indexAvailable ? 1 : 32)
    }
    finally {
      clone.mockRestore()
    }
  })

  it("shares key enumeration and opaque legacy reads within each history batch", async () => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    for (let index = 0; index < 20; index++) {
      const scheduledAt = new Date(Date.UTC(2026, 0, 1, 0, index))
      for (const scheduleId of ["alpha", "beta"]) {
        await store.createRun({ id: `opaque%_${scheduleId}_${index}`, scheduleId, target: "report", scheduledAt,
          createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
      }
    }
    for (const key of await kvStore.keys("vitehub:schedule/schedule-run-index")) await kvStore.del(key)
    const keys = vi.spyOn(kvStore, "keys")
    const get = vi.spyOn(kvStore, "get")
    const queries = ["alpha", "beta"].map(scheduleId => ({ scheduleId, limit: 1 }))
    const results = await store.listRunsBatch!(queries)
    expect(results.map(runs => runs[0]?.id)).toEqual(["opaque%_alpha_19", "opaque%_beta_19"])
    expect(keys).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledTimes(40)
    keys.mockClear()
    get.mockClear()
    await store.listRunsBatch!(queries)
    expect(keys).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledTimes(2)
    const scheduledAt = new Date("2026-02-01T00:00:00Z")
    await createKVScheduleRunStore({ kvStore }).createRun({ id: "external_newest", scheduleId: "alpha", target: "report", scheduledAt,
      createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
    expect((await store.listRunsBatch!(queries))[0]?.[0]?.id).toBe("external_newest")
  })

  it("rereads legacy records after an external update when index writes fail", async () => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    const run = await store.createRun({ id: "legacy-external", scheduleId: "alpha", target: "report",
      scheduledAt: new Date("2026-01-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"), status: "pending", attemptCount: 0 })
    for (const key of await kvStore.keys("vitehub:schedule/schedule-run-index")) await kvStore.del(key)
    const set = kvStore.set.bind(kvStore)
    vi.spyOn(kvStore, "set").mockImplementation(async (key, value) => {
      if (key.includes("/schedule-run-index/")) throw new Error("index unavailable")
      return set(key, value)
    })
    expect((await store.listRuns({ scheduleId: "alpha" }))[0]).toMatchObject({ id: run.id, status: "pending" })

    const externalStore = createKVScheduleRunStore({ kvStore })
    await externalStore.updateRun(run.id, { status: "succeeded", updatedAt: new Date("2026-01-02T00:00:00Z") })
    expect((await store.listRuns({ scheduleId: "alpha" }))[0]).toMatchObject({ id: run.id, status: "succeeded" })
    await kvStore.del((await kvStore.keys("vitehub:schedule/schedule-runs"))[0]!)
    expect(await store.listRuns({ scheduleId: "alpha" })).toEqual([])
  })

  it("keeps all indexed matches when a filter has no limit", async () => {
    const store = createKVScheduleRunStore({ kvStore: createTestKVStore() })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    for (const scheduleId of ["actual", "other"]) {
      for (const id of ["first", "second"]) {
        await store.createRun({ id: `srun_runtime_${scheduleId}_${id}`, scheduleId, target: "report", scheduledAt,
          createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
      }
    }
    expect((await store.listRuns({ scheduleId: "actual" })).map(run => run.id).sort()).toEqual(["srun_runtime_actual_first", "srun_runtime_actual_second"])
    expect(await store.listRuns({ runtimeOnly: true })).toHaveLength(4)
  })

  it.each(["memory", "kv"])("preserves opaque generated-shaped IDs in the %s store", async (kind) => {
    const kvStore = createTestKVStore()
    const store = kind === "memory" ? createMemoryScheduleRunStore() : createKVScheduleRunStore({ kvStore })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const ids = ["srun_runtime_%_2026-05-23T09:00:00.000Z", "srun_runtime_other_2026-05-23T09:00:00.000Z"]
    for (const id of ids) {
      await store.createRun({ id, scheduleId: "actual", target: "report", scheduledAt, createdAt: scheduledAt,
        updatedAt: scheduledAt, status: "pending", attemptCount: 0 })
    }
    expect((await store.listRuns({ scheduleId: "actual", runtimeOnly: true, limit: 10 })).map(run => run.id)).toEqual(ids)
    if (kind === "kv") {
      // Existing records remain readable when they predate the index.
      for (const key of await kvStore.keys("vitehub:schedule/schedule-run-index")) await kvStore.del(key)
      expect((await store.listRuns({ scheduleId: "actual", limit: 10 })).map(run => run.id).sort()).toEqual(ids.toSorted())
    }
  })

  it.each([false, true])("keeps history authoritative when index publication fails after writing %s", async (published) => {
    const kvStore = createTestKVStore()
    const store = createKVScheduleRunStore({ kvStore })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const run = { id: "older", scheduleId: "actual", target: "report", scheduledAt,
      createdAt: scheduledAt, updatedAt: scheduledAt, status: "pending" as const, attemptCount: 0 }
    await store.createRun(run)
    const originalSet = kvStore.set.bind(kvStore)
    const set = vi.spyOn(kvStore, "set")
    set.mockImplementation(async (key, value) => {
      if (key.includes("/schedule-run-index/")) {
        if (published) await originalSet(key, value)
        throw new Error("index unavailable")
      }
      await originalSet(key, value)
    })
    const newer = { ...run, id: "index-failure", scheduledAt: new Date("2026-05-24T09:00:00.000Z") }
    await expect(store.createRun(newer)).resolves.toEqual(newer)
    expect(await store.getRun(newer.id)).toEqual(newer)
    expect(await store.listRuns({ scheduleId: "actual", limit: 1 })).toEqual([newer])
    set.mockImplementation(async (key, value) => {
      if (key.includes("/schedule-runs/")) throw new Error("record unavailable")
      await originalSet(key, value)
    })
    await expect(store.createRun({ ...run, id: "record-failure", scheduledAt: new Date("2026-05-25T09:00:00.000Z") })).rejects.toThrow("record unavailable")
    expect(await store.getRun("record-failure")).toBeUndefined()
    expect(await kvStore.keys("vitehub:schedule/schedule-run-index/record-failure/")).toEqual([])
    set.mockRestore()
    const retried = { ...run, id: "record-failure", scheduleId: "other", scheduledAt: new Date("2026-05-26T09:00:00.000Z") }
    await store.createRun(retried)
    expect(await store.listRuns({ scheduleId: "actual", limit: 1 })).toEqual([newer])
    expect(await store.listRuns({ scheduleId: "other", limit: 1 })).toEqual([retried])
  })

  it("matches the ScheduleRunStore run and attempt contract and round-trips dates and errors", async () => {
    const store = createKVScheduleRunStore({ kvStore: createTestKVStore(), prefix: "tests/runs" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const scheduledAt = new Date("2026-05-23T09:30:00.000Z")
    const startedAt = new Date("2026-05-23T09:30:01.000Z")
    const completedAt = new Date("2026-05-23T09:30:05.000Z")
    const updatedAt = new Date("2026-05-23T09:30:06.000Z")
    const error = { message: "boom", name: "TypeError", stack: "stack" }

    const run = await store.createRun({
      attemptCount: 0,
      createdAt,
      id: "run/1",
      scheduleId: "schedule/1",
      scheduledAt,
      status: "pending",
      target: "daily/report",
      updatedAt: createdAt,
    })
    const attempt = await store.createAttempt({
      createdAt,
      id: "attempt/1",
      runId: run.id,
      startedAt,
      status: "running",
      updatedAt: createdAt,
    })

    expect(await store.getRun(run.id)).toEqual(run)
    expect(await store.getAttempt(attempt.id)).toEqual(attempt)
    expect(await store.listRuns()).toEqual([run])
    expect(await store.listAttempts(run.id)).toEqual([attempt])

    const failedRun = await store.updateRun(run.id, {
      attemptCount: 1,
      completedAt,
      error,
      startedAt,
      status: "failed",
      updatedAt,
    })
    const failedAttempt = await store.updateAttempt(attempt.id, {
      completedAt,
      error,
      status: "failed",
      updatedAt,
    })

    expect(failedRun).toMatchObject({ error, status: "failed" })
    expect(failedRun?.completedAt).toEqual(completedAt)
    expect(failedRun?.scheduledAt).toEqual(scheduledAt)
    expect(failedRun?.startedAt).toEqual(startedAt)
    expect(failedRun?.updatedAt).toEqual(updatedAt)
    expect(failedAttempt).toMatchObject({ error, status: "failed" })
    expect(failedAttempt?.completedAt).toEqual(completedAt)
    expect(failedAttempt?.startedAt).toEqual(startedAt)
    expect(failedAttempt?.updatedAt).toEqual(updatedAt)

    error.message = "mutated source"
    expect((await store.getRun(run.id))?.error).toMatchObject({ message: "boom" })
    expect((await store.getAttempt(attempt.id))?.error).toMatchObject({ message: "boom" })

    failedRun!.error!.message = "mutated"
    failedAttempt!.error!.message = "mutated"
    expect((await store.getRun(run.id))?.error).toMatchObject({ message: "boom" })
    expect((await store.getAttempt(attempt.id))?.error).toMatchObject({ message: "boom" })
    const listedRun = (await store.listRuns())[0]
    listedRun!.error!.message = "listed mutation"
    expect((await store.getRun(run.id))?.error).toMatchObject({ message: "boom" })
    const listedAttempt = (await store.listAttempts(run.id))[0]
    listedAttempt!.error!.message = "listed mutation"
    expect((await store.getAttempt(attempt.id))?.error).toMatchObject({ message: "boom" })

    await expect(store.createRun(run)).rejects.toThrow("Schedule Run already exists: run/1")
    await expect(store.createAttempt(attempt)).rejects.toThrow("Schedule Run Attempt already exists: attempt/1")
    await expect(store.updateRun("missing", { status: "failed", updatedAt })).resolves.toBeUndefined()
    await expect(store.updateAttempt("missing", { status: "failed", updatedAt })).resolves.toBeUndefined()
  })

  it("serializes concurrent creates for the same KV schedule run key", async () => {
    const kvStore = createDelayedHasKVStore()
    const store = createKVScheduleRunStore({ kvStore, prefix: "tests/runs-lock" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const run = {
      attemptCount: 0,
      createdAt,
      id: "run/1",
      scheduleId: "schedule/1",
      scheduledAt: createdAt,
      status: "pending" as const,
      target: "daily/report",
      updatedAt: createdAt,
    }

    const first = store.createRun(run)
    const second = store.createRun(run)
    await flushAsyncWork()
    kvStore.releaseHas()

    const results = await Promise.allSettled([first, second])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    await expect(store.getRun("run/1")).resolves.toMatchObject({ id: "run/1" })
  })

  it("serializes concurrent creates for the same KV schedule run attempt key", async () => {
    const kvStore = createDelayedHasKVStore()
    const store = createKVScheduleRunStore({ kvStore, prefix: "tests/run-attempts-lock" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const attempt = {
      createdAt,
      id: "attempt/1",
      runId: "run/1",
      startedAt: createdAt,
      status: "running" as const,
      updatedAt: createdAt,
    }

    const first = store.createAttempt(attempt)
    const second = store.createAttempt(attempt)
    await flushAsyncWork()
    kvStore.releaseHas()

    const results = await Promise.allSettled([first, second])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    await expect(store.getAttempt("attempt/1")).resolves.toMatchObject({ id: "attempt/1" })
  })

  it("serializes concurrent updates for the same KV schedule run and attempt keys", async () => {
    const kvStore = createDelayedGetKVStore()
    const store = createKVScheduleRunStore({ kvStore, prefix: "tests/update-lock" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    await store.createRun({
      attemptCount: 0,
      createdAt,
      id: "run/1",
      scheduleId: "schedule/1",
      scheduledAt: createdAt,
      status: "pending",
      target: "daily/report",
      updatedAt: createdAt,
    })
    await store.createAttempt({
      createdAt,
      id: "attempt/1",
      runId: "run/1",
      startedAt: createdAt,
      status: "running",
      updatedAt: createdAt,
    })

    const runStatus = store.updateRun("run/1", { status: "succeeded", updatedAt: new Date("2026-05-23T09:01:00.000Z") })
    const runAttempts = store.updateRun("run/1", { attemptCount: 1, updatedAt: new Date("2026-05-23T09:02:00.000Z") })
    const attemptStatus = store.updateAttempt("attempt/1", { status: "succeeded", updatedAt: new Date("2026-05-23T09:03:00.000Z") })
    const attemptError = store.updateAttempt("attempt/1", { error: { message: "late" }, updatedAt: new Date("2026-05-23T09:04:00.000Z") })
    await flushAsyncWork()
    kvStore.releaseGet()
    await Promise.all([runStatus, runAttempts, attemptStatus, attemptError])

    await expect(store.getRun("run/1")).resolves.toMatchObject({ status: "succeeded", attemptCount: 1 })
    await expect(store.getAttempt("attempt/1")).resolves.toMatchObject({ status: "succeeded", error: { message: "late" } })
  })
})

describe("Schedule response persistence", () => {
  it.each(["memory", "kv"])("preserves binary bodies and header tuples in the %s store", async (kind) => {
    const store = kind === "memory" ? createMemoryScheduleRunStore() : createKVScheduleRunStore({ kvStore: createTestKVStore() })
    const now = new Date()
    const response = await serializeResponse(new Response(new Uint8Array([0, 128, 255]), { headers: { "x-result": "saved" } }))
    const run = await store.createRun({
      id: "response-run", scheduleId: "schedule/response", attemptCount: 0, createdAt: now, scheduledAt: now,
      status: "succeeded", target: "daily/report", updatedAt: now, response,
    })
    expect(run.response).toEqual(response)
    const stored = await store.getRun(run.id)
    expect(stored?.response).toEqual(response)
    const restored = deserializeResponse(stored!.response!)
    expect(restored.headers.get("x-result")).toBe("saved")
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]))
    Object.assign(run.response!.headers[0]!, { 1: "changed" })
    expect((await store.getRun(run.id))?.response).toEqual(response)
    expect((await store.listRuns())[0]?.response).toEqual(response)
  })
})
