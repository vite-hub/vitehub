import { afterEach, describe, expect, it } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"
import { createKVRuntimeScheduleStore, createKVScheduleRunStore, createMemoryScheduleRunStore, createScheduleRun, defineScheduleTarget, executeRuntimeSchedule, executeStaticSchedule, schedules, type ScheduleKVStorage } from "../src/index.ts"
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
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

    const created = await schedules.create({
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

    const created = await schedules.create({
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
    const updated = await schedules.update("schedule-1", { input: replacement })
    replacement.prompt = "mutated"
    expect(updated.input).toEqual({ prompt: "Evening report", settings: { concise: false } })

    await schedules.update("schedule-1", { cron: "0 18 * * *" })
    expect((await schedules.get("schedule-1"))?.input).toEqual({ prompt: "Evening report", settings: { concise: false } })

    const cleared = await schedules.update("schedule-1", { input: undefined })
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

    const created = await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const updated = await schedules.update("schedule-1", { cron: "15 10 * * *", target: "cleanup", timeZone: "Europe/Copenhagen" })
    expect(updated).toMatchObject({ cron: "15 10 * * *", enabled: true, id: "schedule-1", target: "cleanup", timeZone: "Europe/Copenhagen" })
    expect(updated.createdAt).toEqual(created.createdAt)
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    expect(await schedules.update("schedule-1", { enabled: false })).toMatchObject({ enabled: false, timeZone: "Europe/Copenhagen" })
    expect(await schedules.update("schedule-1", { timeZone: "UTC" })).toMatchObject({ timeZone: "UTC" })
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.create({ cron: "0 10 * * *", id: "schedule-1", target: "report" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "99 9 * * *", target: "report" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", target: "report", timeZone: "Not/A_Zone" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.create({ cron: "0 9 * * *", target: "report", timeZone: "+01:00" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.create({ cron: "0 9 * * *", target: "report", timeZone: "PST" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })

    const linked = await schedules.create({ cron: "0 9 * * *", id: "linked-zone", target: "report", timeZone: "Asia/Kolkata" })
    expect(linked).toMatchObject({ timeZone: "Asia/Kolkata" })
    await expect(schedules.update("linked-zone", { timeZone: "US/Eastern" })).resolves.toMatchObject({ timeZone: "US/Eastern" })
    await expect(schedules.update("linked-zone", { timeZone: "Etc/UTC" })).resolves.toMatchObject({ timeZone: "Etc/UTC" })
    await expect(schedules.update("linked-zone", { timeZone: "CET" })).resolves.toMatchObject({ timeZone: "CET" })
    await expect(schedules.update("linked-zone", { timeZone: "EST5EDT" })).resolves.toMatchObject({ timeZone: "EST5EDT" })
    await expect(schedules.update("linked-zone", { timeZone: "PST8PDT" })).resolves.toMatchObject({ timeZone: "PST8PDT" })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.update("schedule-1", { timeZone: "Not/A_Zone" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_TIME_ZONE",
    })
    await expect(schedules.update("schedule-1", { timeZone: "-05:30" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", target: "report", timezone: "UTC" } as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
      message: "Runtime Schedule input is invalid.",
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.update("schedule-1", { timezone: "UTC" } as never)).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", id: "", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ID",
    })
    await expect(schedules.create({ cron: "0 9 * * *", id: 123 as never, target: "report" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", enabled: "false" as never, target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.update("schedule-1", { enabled: "false" as never })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })
  })

  it("rejects non-object runtime schedule create and update inputs", async () => {
    await expect(schedules.create(null as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
    await expect(schedules.create("bad" as never)).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_INPUT",
    })
    await expect(schedules.update("schedule-1", null as never)).rejects.toMatchObject({
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
    await expect(schedules.create({ cron: "0 9 * * *", target: "missing" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", target: "report" })).rejects.toMatchObject({
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

    await expect(schedules.create({ cron: "0 9 * * *", target: "__proto__" })).rejects.toMatchObject({
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
    await expect(schedules.update("missing", { enabled: false })).rejects.toBeInstanceOf(ViteHubError)
    await expect(schedules.update("missing", { enabled: false })).rejects.toMatchObject({
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", input: { prompt: "Daily report" }, target: "report" })
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
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

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
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

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
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await schedules.disable("schedule-1")

    await expect(schedules.run("schedule-1")).rejects.toMatchObject({
      code: "SCHEDULE_DISABLED",
    })
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
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
    await schedules.create({ cron: "0 9 * * *", id: "shared-id", target: "report" })

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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
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

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.run("schedule-1", { scheduledAt: new Date("2026-05-23T09:00:00.000Z") })).rejects.toThrow("boom")
    const [run] = await schedules.listRuns()
    run!.error!.message = "mutated"

    expect((await schedules.getRun(run!.id))!.error).toMatchObject({ message: "boom" })
  })
})

describe("KV Schedule Run Store", () => {
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
})
