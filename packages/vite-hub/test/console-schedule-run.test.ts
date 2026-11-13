import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { Plugin } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { defineSchedule } from "@vite-hub/schedule"
import { scheduleOperations } from "../../schedule/dist/operations.js"
import { createMemoryScheduleRunStore, resetScheduleRuntime } from "@vite-hub/schedule/runtime"
import { readScheduleConsoleRecords } from "../../schedule/dist/runtime/console.js"
import { installProcessScheduleRuntime } from "@vite-hub/schedule/runtime/process"

import { consoleSchedulesKey, consoleStateKey } from "../src/console/internal.ts"
import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { vitehub } from "../src/index.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { listConsoleDefinitions } from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions, installConsoleSchedules } from "../src/console/runtime/server/definitions.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import { consoleAccess } from "./support/console-access.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const schedules = async () => listConsoleDefinitions({ section: "schedules" }, await consoleAccess())


const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  Reflect.deleteProperty(globalThis, consoleStateKey)
  Reflect.deleteProperty(globalThis, consoleSchedulesKey)
  resetScheduleRuntime()
  installConsoleOperations([])
})

const scheduleSummary = (name: string) => ({
  fields: [{ label: "Kind", value: "Static schedule" }],
  file: `server/schedules/${name}.ts`,
  name,
  source: "server-schedules",
})

function installSchedules(handler: (context: { scheduledAt: Date }) => unknown = () => {}) {
  installConsoleOperations([{ operations: scheduleOperations, plugin: "@vite-hub/schedule/vite" }])
  installConsoleSections("/schedule-run", ["schedules"])
  installConsoleDefinitions("/schedule-run", { schedules: { definitions: [scheduleSummary("sync"), scheduleSummary("nightly")], kind: "definition-catalog" } })
  installConsoleSchedules("/schedule-run", {
    sync: async () => ({ default: defineSchedule({ cron: "*/5 * * * *", manual: true, handler }) }),
  })
}

async function call(operation: string, input: Record<string, unknown>): Promise<unknown> {
  const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
    body: operationRpcBody(operation, input),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
  return operationRpcResponseResult(response)
}

describe("Console Schedule runs", () => {
  it("installs only manual Static Schedule Definitions, and only with Console invocation", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-run-")
    const plugin = join(root, "console.mjs")
    const handler = join(root, "server/schedules/sync.ts")
    const catalog = { agents: [], content: { schedules: { definitions: [scheduleSummary("sync")], kind: "definition-catalog" as const } }, manualSchedules: [{ handler, name: "sync" }] }

    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["schedules"], catalog, blobStores: [], invoke: true })
    const invokeEnabled = await readFile(plugin, "utf8")
    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["schedules"], catalog, blobStores: [] })
    const invokeDisabled = await readFile(plugin, "utf8")

    expect(invokeEnabled).toContain(`{ installConsoleDefinitions, installConsoleSchedules }`)
    expect(invokeEnabled).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
    expect(invokeEnabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, { ["sync"]: () => import(${JSON.stringify(pathToFileURL(handler).href)}) })`)
    expect(invokeDisabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, {})`)
    expect(invokeDisabled).not.toContain(pathToFileURL(handler).href)
  })

  it("emits prototype-named Schedules as own registry keys", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-prototype-")
    const plugin = join(root, "console.mjs")
    const handler = join(root, "server/schedules/__proto__.ts")
    const catalog = { agents: [], content: { schedules: { definitions: [scheduleSummary("__proto__")], kind: "definition-catalog" as const } }, manualSchedules: [{ handler, name: "__proto__" }] }

    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["schedules"], catalog, blobStores: [], invoke: true })

    expect(await readFile(plugin, "utf8")).toContain(`{ ["__proto__"]: () => import(${JSON.stringify(pathToFileURL(handler).href)}) }`)
  })

  it("installs manual Schedules for `vitehub schedule run` in vite dev without a console option", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-dev-")
    await writeFile(join(root, "package.json"), "{}\n")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/schedules/daily-report.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 8 * * *', manual: true, handler() {} })\n")
    const plugin = vitehub({ host: "node", schedule: true }).flat()
      .find((option): option is Plugin => option !== null && typeof option === "object" && "name" in option && option.name === "vite-hub/console")
    const hook = plugin?.config
    const config = typeof hook === "function" ? hook : hook?.handler
    if (!config) throw new TypeError("Expected the Console config hook.")

    await Reflect.apply(config, {}, [{ root }, { command: "serve", mode: "development" }])

    const handler = pathToFileURL(join(root, "server/schedules/daily-report.ts")).href
    expect(await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).toContain(`installConsoleSchedules(${JSON.stringify(root)}, { ["daily-report"]: () => import(${JSON.stringify(handler)}) })`)
  })

  it("discovers manual Static Schedule Definitions for the Console", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-catalog-")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/schedules/sync.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '*/5 * * * *', manual: true, handler() {} })\n")
    await writeFile(join(root, "server/schedules/nightly.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 3 * * *', handler() {} })\n")

    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })

    expect(catalog.manualSchedules).toEqual([{ handler: join(root, "server/schedules/sync.ts"), name: "sync" }])
  })

  it("shows the time zone that the process runtime uses, when the source sets it with a constant", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-time-zone-")
    const plugin = join(root, "console.mjs")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/schedules/brief.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nconst COPENHAGEN = 'Europe/Copenhagen'\nexport default defineSchedule({ cron: '0 14 * * 1', timeZone: COPENHAGEN, handler() {} })\n")
    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })
    await writeConsoleNitroPlugin({ file: plugin, projectRoot: root, sections: ["schedules"], catalog, blobStores: [] })
    const generated = await readFile(plugin, "utf8")
    expect(generated).toContain(`{ readScheduleConsoleRecords: vitehubConsoleRuntimeReader0 }`)
    expect(generated).toMatch(/import\("[^"]*[\\/]schedule[\\/](?:src|dist)[\\/]runtime[\\/]console\.(?:ts|js)"\)/)
    expect(generated).toContain(`{ "schedules": vitehubConsoleRuntimeReader0 }`)

    const timeZone = (): Promise<string[]> => schedules()
      .then(content => content.kind === "record-table" ? content.records.map(record => `${record.cells.timing} / ${record.fields.find(field => field.label === "Time zone")?.value}`) : [])
    installConsoleDefinitions(root, catalog.content, [], { schedules: readScheduleConsoleRecords })
    expect(await timeZone()).toEqual(["0 14 * * 1 (Not a static string) / Not a static string"])

    const zone = "Europe/Copenhagen"
    const runtime = await installProcessScheduleRuntime({
      registry: { brief: async () => ({ default: defineSchedule({ cron: "0 14 * * 1", handler() {}, timeZone: zone }) }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    try {
      expect(await timeZone()).toEqual(["0 14 * * 1 (Europe/Copenhagen) / Europe/Copenhagen"])
    }
    finally {
      await runtime.close()
    }
  })

  it("marks runnable Schedule Definitions in the catalog", async () => {
    installSchedules()

    expect(await schedules()).toEqual({
      definitions: [{ ...scheduleSummary("sync"), runnable: true }, scheduleSummary("nightly")],
      kind: "definition-catalog",
      section: "schedules",
    })
  })

  it("marks only installed manual definitions as runnable in the contributed record table", async () => {
    installSchedules()
    // The Schedule package writes these cells for each Schedule Definition record.
    const records = ["definition:sync", "definition:nightly", "other:sync"].map(id => ({
      cells: { manual: "Enabled", schedule: id.split(":")[1]!, timing: "0 9 * * *" },
      fields: [],
      id,
    }))
    installConsoleDefinitions("/schedule-run", { schedules: { kind: "record-table", records } })

    expect(await schedules()).toEqual({
      kind: "record-table",
      records: [{ ...records[0], runnable: true }, records[1], records[2]],
      section: "schedules",
    })
  })

  it("runs a Schedule through the Console RPC operation", async () => {
    let calls = 0
    installSchedules(() => { calls++ })
    const run = await call("schedule.run", { name: "sync" })
    const unavailable = await call("schedule.run", { name: "nightly" })
    const read = await call("schedule.run", {})

    expect(run).toEqual({
      ok: true,
      value: {
        run: {
          completedAt: expect.any(String),
          id: expect.stringMatching(/^srun_manual_sync_/),
          scheduleId: "sync",
          scheduledAt: expect.any(String),
          startedAt: expect.any(String),
          status: "succeeded",
        },
      },
    })
    expect(unavailable).toMatchObject({
      code: "SCHEDULE_DEFINITION_NOT_FOUND",
      message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation.",
      ok: false,
      status: 404,
    })
    expect(read).toMatchObject({ code: "INTERNAL_R0022", ok: false, status: 400 })
    expect(calls).toBe(1)
  })

  it("returns a failed run with its error and without its stack", async () => {
    installSchedules(() => {
      throw new TypeError("mailbox unavailable")
    })

    const body = await call("schedule.run", { name: "sync" })

    expect(body).toEqual({
      ok: true,
      value: {
        run: {
          completedAt: expect.any(String),
          error: { message: "mailbox unavailable", name: "TypeError" },
          id: expect.stringMatching(/^srun_manual_sync_/),
          scheduleId: "sync",
          scheduledAt: expect.any(String),
          startedAt: expect.any(String),
          status: "failed",
        },
      },
    })
  })

  it("answers 404 through the operation when Console invocation did not install Schedule runs", async () => {
    installConsoleSections("/schedule-run", ["schedules"])
    installConsoleSchedules("/schedule-run", {})
    installConsoleOperations([{ operations: scheduleOperations, plugin: "@vite-hub/schedule/vite" }])

    expect(await call("schedule.run", { name: "sync" })).toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND", ok: false, status: 404 })
  })

  it("lists the runs and the attempts of a Schedule", async () => {
    installSchedules()
    await call("schedule.run", { name: "sync" })
    const runs = await call("schedule.runs", { id: "sync" }) as { ok: true, value: { runs: Array<{ id: string }> } }
    expect(runs).toMatchObject({ ok: true, value: { runs: [{ scheduleId: "sync", status: "succeeded" }] } })
    const attempts = await call("schedule.attempts", { id: runs.value.runs[0]!.id })
    expect(attempts).toMatchObject({ ok: true, value: { attempts: [{ status: "succeeded" }], run: { id: runs.value.runs[0]!.id } } })
    expect(await call("schedule.attempts", { id: "srun_missing" })).toMatchObject({ code: "SCHEDULE_RUN_NOT_FOUND", ok: false, status: 404 })
  })
})
