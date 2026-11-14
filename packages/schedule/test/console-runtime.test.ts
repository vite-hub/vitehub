import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { inspectScheduleConsoleRecords, scheduleConsoleSection } from "../src/inspect.ts"
import { readScheduleConsoleRecords } from "../src/runtime/console.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { resetScheduleRuntime, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

const roots: string[] = []

afterEach(async () => {
  resetScheduleRuntime()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Schedule Console runtime records", () => {
  it("does not advertise manual execution for a Definition without cron", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-startable-console-"))
    roots.push(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "reminder.ts"), "export default defineSchedule({ handler: () => {}, manual: true })\n")
    const records = await inspectScheduleConsoleRecords({ projectRoot: root, rootDir: root, serverRootDir: root })
    const reminder = records.find(record => record.id === "definition:reminder")
    expect(reminder).toMatchObject({ cells: { manual: "Disabled", timing: "Started by code" }, runnable: false })
    expect(reminder?.fields).not.toContainEqual({ label: "Manual", value: "Enabled" })
    expect(records.find(record => record.id === "definition:vitehub/started-schedules")?.runnable).toBe(true)
  })

  it("shows the time zone and cron that the process runtime uses, from any expression", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-console-"))
    roots.push(root)
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await writeFile(join(root, "server", "schedules", "brief.ts"), "const zone = 'Europe/Madrid'\nexport default defineSchedule({ cron: '15 6 * * 1-5', timeZone: zone, handler: () => {} })\n", "utf8")
    const [built] = await inspectScheduleConsoleRecords({ projectRoot: root, rootDir: root, serverRootDir: root })
    expect(built!.fields).toContainEqual({ label: "Time zone", value: "Not a static string" })

    const zone = "Europe/Madrid"
    const cron = ["15", "6", "*", "*", "1-5"].join(" ")
    const controller = await installProcessScheduleRuntime({
      intervalMs: 60_000,
      registry: { brief: async () => defineSchedule({ cron, handler: () => {}, timeZone: zone }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      expect(await readScheduleConsoleRecords()).toEqual([{
        cells: { schedule: "brief", timing: "15 6 * * 1-5 (Europe/Madrid)" },
        fields: [{ label: "Cron", value: "15 6 * * 1-5" }, { label: "Time zone", value: "Europe/Madrid" }],
        id: built!.id,
      }])
    }
    finally {
      await controller.close()
    }
  })

  it("shows UTC for a Schedule without a time zone", async () => {
    const controller = await installProcessScheduleRuntime({
      registry: { report: async () => ({ default: defineSchedule({ cron: "0 9 * * *", handler: () => {} }) }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      expect(await readScheduleConsoleRecords()).toEqual([{
        cells: { schedule: "report", timing: "0 9 * * *" },
        fields: [{ label: "Cron", value: "0 9 * * *" }, { label: "Time zone", value: "UTC" }],
        id: "definition:report",
      }])
    }
    finally {
      await controller.close()
    }
  })

  it("reads the scheduled snapshot without loading the registry again", async () => {
    const handler = vi.fn()
    const load = vi.fn()
      .mockResolvedValueOnce(defineSchedule({ cron: "0 8 * * *", handler, timeZone: "Europe/Madrid" }))
      .mockResolvedValue(defineSchedule({ cron: "0 9 * * *", handler, timeZone: "UTC" }))
    const controller = await installProcessScheduleRuntime({
      now: () => new Date("2026-07-15T06:00:00.000Z"),
      registry: { report: load },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
      const expected = [{
        cells: { schedule: "report", timing: "0 8 * * * (Europe/Madrid)" },
        fields: [{ label: "Cron", value: "0 8 * * *" }, { label: "Time zone", value: "Europe/Madrid" }],
        id: "definition:report",
      }]
      expect(await readScheduleConsoleRecords()).toEqual(expected)
      expect(await readScheduleConsoleRecords()).toEqual(expected)
      expect(load).toHaveBeenCalledOnce()
    }
    finally {
      await controller.close()
    }
    expect(await readScheduleConsoleRecords()).toEqual([])
  })

  it("keeps the build-time records for a registry without a Process Runtime", async () => {
    const load = vi.fn(async () => defineSchedule({ cron: "0 9 * * *", handler: () => {} }))
    setScheduleRuntimeRegistry({ report: load })
    expect(await readScheduleConsoleRecords()).toEqual([])
    expect(load).not.toHaveBeenCalled()
  })

  it("restores the active snapshot when a replacement runtime fails to install", async () => {
    const controller = await installProcessScheduleRuntime({
      registry: { report: async () => defineSchedule({ cron: "0 9 * * *", handler: () => {} }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      const expected = await readScheduleConsoleRecords()
      await expect(installProcessScheduleRuntime({
        registry: { invalid: async () => ({ cron: "bad", handler: () => {} }) },
        scheduleRunStore: createMemoryScheduleRunStore(),
      })).rejects.toThrow("five-field cron expression")
      expect(await readScheduleConsoleRecords()).toEqual(expected)
    }
    finally {
      await controller.close()
    }
  })

  it("keeps the active snapshot while a replacement loads and reconciles", async () => {
    const controller = await installProcessScheduleRuntime({
      registry: { report: async () => defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: "Europe/Madrid" }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    const expected = await readScheduleConsoleRecords()
    let releaseLoad!: () => void
    const loading = new Promise<void>(resolve => { releaseLoad = resolve })
    let releaseReconcile!: () => void
    const reconciliation = new Promise<void>(resolve => { releaseReconcile = resolve })
    let startedReconcile!: () => void
    const reconciling = new Promise<void>(resolve => { startedReconcile = resolve })
    const scheduleRunStore = createMemoryScheduleRunStore()
    vi.spyOn(scheduleRunStore, "listRuns").mockImplementation(async () => {
      startedReconcile()
      await reconciliation
      return []
    })
    const installing = installProcessScheduleRuntime({
      registry: { replacement: async () => {
        await loading
        return defineSchedule({ cron: "0 10 * * *", handler: () => {} })
      } },
      scheduleRunStore,
    })
    try {
      expect(await readScheduleConsoleRecords()).toEqual(expected)
      releaseLoad()
      await reconciling
      expect(await readScheduleConsoleRecords()).toEqual(expected)
      releaseReconcile()
      const replacement = await installing
      expect(await readScheduleConsoleRecords()).toEqual([{
        cells: { schedule: "replacement", timing: "0 10 * * *" },
        fields: [{ label: "Cron", value: "0 10 * * *" }, { label: "Time zone", value: "UTC" }],
        id: "definition:replacement",
      }])
      await replacement.close()
      expect(await readScheduleConsoleRecords()).toEqual(expected)
    }
    finally {
      releaseLoad()
      releaseReconcile()
      await (await installing).close()
      await controller.close()
    }
    expect(await readScheduleConsoleRecords()).toEqual([])
  })

  it.each(["previous", "replacement"] as const)("keeps only live snapshots when closing the %s controller first", async (first) => {
    const controller = await installProcessScheduleRuntime({
      registry: { report: async () => defineSchedule({ cron: "0 9 * * *", handler: () => {} }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    const previous = await readScheduleConsoleRecords()
    const replacement = await installProcessScheduleRuntime({
      registry: { replacement: async () => defineSchedule({ cron: "0 10 * * *", handler: () => {} }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      const expected = await readScheduleConsoleRecords()
      if (first === "previous") {
        await controller.close()
        expect(await readScheduleConsoleRecords()).toEqual(expected)
        await replacement.close()
      }
      else {
        await replacement.close()
        expect(await readScheduleConsoleRecords()).toEqual(previous)
        await controller.close()
      }
      expect(await readScheduleConsoleRecords()).toEqual([])
    }
    finally {
      await replacement.close()
      await controller.close()
    }
  })

  it("keeps the build-time records when this process runs no Schedules", async () => {
    expect(await readScheduleConsoleRecords()).toEqual([])
  })

  it("names the runtime reader in the Console section", () => {
    expect(scheduleConsoleSection).toMatchObject({ runtime: { export: "readScheduleConsoleRecords", module: expect.stringMatching(/[\\/]schedule[\\/](?:src|dist)[\\/]runtime[\\/]console\.(?:ts|js)$/) } })
  })
})
