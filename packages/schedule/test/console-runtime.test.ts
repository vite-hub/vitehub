import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { inspectScheduleConsoleRecords, scheduleConsoleSection } from "../src/inspect.ts"
import { readScheduleConsoleRecords } from "../src/runtime/console.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

const roots: string[] = []

afterEach(async () => {
  resetScheduleRuntime()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Schedule Console runtime records", () => {
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

  it("keeps the build-time records when this process runs no Schedules", async () => {
    expect(await readScheduleConsoleRecords()).toEqual([])
  })

  it("names the runtime reader in the Console section", () => {
    expect(scheduleConsoleSection).toMatchObject({ runtime: { export: "readScheduleConsoleRecords", module: "@vite-hub/schedule/runtime/console" } })
  })
})
