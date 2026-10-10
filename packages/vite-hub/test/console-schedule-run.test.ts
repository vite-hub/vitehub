import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { defineSchedule } from "@vite-hub/schedule"
import { resetScheduleRuntime } from "@vite-hub/schedule/runtime"

import { consoleDefinitionsKey, consoleDefinitionsRegistryKey, consoleDefinitionsRootKey, consoleSchedulesKey, consoleSchedulesRegistryKey, consoleSchedulesRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import definitionsHandlerRoute from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions, installConsoleSchedules } from "../src/console/runtime/server/definitions.ts"
import { handleConsoleScheduleRunRequest } from "../src/console/runtime/server/schedule-run.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRpcInput, ConsoleRpcMethod } from "../src/console/runtime/rpc.ts"
import { allowed } from "./support/console-access.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

const definitionsHandler = allowed(definitionsHandlerRoute)

// SAFETY: Console state uses the same optional symbol keys in runtime and tests.
const scope = globalThis as ConsoleInvocationScope
const symbols = [
  consoleDefinitionsKey,
  consoleDefinitionsRegistryKey,
  consoleDefinitionsRootKey,
  consoleSchedulesKey,
  consoleSchedulesRegistryKey,
  consoleSchedulesRootKey,
  consoleSectionsKey,
  consoleSectionsRegistryKey,
  consoleSectionsRootKey,
]

const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { force: true, recursive: true })))
  for (const key of symbols) {
    Reflect.deleteProperty(scope, key)
    Reflect.deleteProperty(process, key)
  }
  resetScheduleRuntime()
})

const scheduleSummary = (name: string) => ({
  fields: [{ label: "Kind", value: "Static schedule" }],
  file: `server/schedules/${name}.ts`,
  name,
  source: "server-schedules",
})

function installSchedules(handler: () => unknown = () => {}) {
  installConsoleSections("/schedule-run", ["schedules"])
  installConsoleDefinitions("/schedule-run", { schedules: { definitions: [scheduleSummary("sync"), scheduleSummary("nightly")], kind: "definition-catalog" } })
  installConsoleSchedules("/schedule-run", {
    sync: async () => ({ default: defineSchedule("*/5 * * * *", handler, { manual: true }) }),
  })
}

function runRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.example/_vitehub/schedules/run", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

describe("Console Schedule runs", () => {
  it("installs only manual Static Schedule Definitions, and only with Console invocation", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-run-")
    const plugin = join(root, "console.mjs")
    const handler = join(root, "server/schedules/sync.ts")
    const catalog = { agents: [], content: { schedules: { definitions: [scheduleSummary("sync")], kind: "definition-catalog" as const } }, manualSchedules: [{ handler, name: "sync" }] }

    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], [], undefined, undefined, true)
    const invokeEnabled = await readFile(plugin, "utf8")
    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], [])
    const invokeDisabled = await readFile(plugin, "utf8")

    expect(invokeEnabled).toContain(`import { installConsoleDefinitions, installConsoleSchedules } from "vite-hub/console/definitions"`)
    expect(invokeEnabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, { ["sync"]: () => import(${JSON.stringify(pathToFileURL(handler).href)}) })`)
    expect(invokeDisabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, {})`)
    expect(invokeDisabled).not.toContain(pathToFileURL(handler).href)
  })

  it("emits prototype-named Schedules as own registry keys", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-prototype-")
    const plugin = join(root, "console.mjs")
    const handler = join(root, "server/schedules/__proto__.ts")
    const catalog = { agents: [], content: { schedules: { definitions: [scheduleSummary("__proto__")], kind: "definition-catalog" as const } }, manualSchedules: [{ handler, name: "__proto__" }] }

    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], [], undefined, undefined, true)

    expect(await readFile(plugin, "utf8")).toContain(`{ ["__proto__"]: () => import(${JSON.stringify(pathToFileURL(handler).href)}) }`)
  })

  it("discovers manual Static Schedule Definitions for the Console", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-catalog-")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/schedules/sync.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '*/5 * * * *', manual: true, handler() {} })\n")
    await writeFile(join(root, "server/schedules/nightly.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 3 * * *', handler() {} })\n")

    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })

    expect(catalog.manualSchedules).toEqual([{ handler: join(root, "server/schedules/sync.ts"), name: "sync" }])
  })

  it("marks runnable Schedule Definitions in the catalog", async () => {
    installSchedules()

    expect(await definitionsHandler({ method: "GET", req: { method: "GET", url: "http://localhost/api/_vitehub/console/definitions?section=schedules" } })).toEqual({
      definitions: [{ ...scheduleSummary("sync"), runnable: true }, scheduleSummary("nightly")],
      kind: "definition-catalog",
      section: "schedules",
    })
  })

  it("marks only installed manual definitions as runnable in the contributed record table", async () => {
    installSchedules()
    const records = ["definition:sync", "definition:nightly", "runtime:sync"].map(id => ({
      cells: { kind: id.startsWith("definition:") ? "Definition" : "Runtime", schedule: id.split(":")[1]! },
      fields: [],
      id,
    }))
    installConsoleDefinitions("/schedule-run", { schedules: { kind: "record-table", records } })

    expect(await definitionsHandler({ method: "GET", req: { method: "GET", url: "http://localhost/api/_vitehub/console/definitions?section=schedules" } })).toEqual({
      kind: "record-table",
      records: [{ ...records[0], runnable: true }, records[1], records[2]],
      section: "schedules",
    })
  })

  it("runs a Schedule through the Console RPC operation", async () => {
    let calls = 0
    installSchedules(() => { calls++ })
    async function call(method: ConsoleRpcMethod, input: ConsoleRpcInput) {
      const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
        body: JSON.stringify({ input, method }),
        headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
        method: "POST",
      }))
      return response.json()
    }

    const run = await call(consoleRpcMethods.scheduleRun, { body: { name: "sync" }, method: "POST" })
    const unavailable = await call(consoleRpcMethods.scheduleRun, { body: { name: "nightly" }, method: "POST" })
    const read = await call(consoleRpcMethods.scheduleRun, { method: "GET" })

    expect(run).toEqual({
      ok: true,
      value: {
        run: {
          completedAt: expect.any(String),
          id: expect.stringMatching(/^srun_manual_sync_/),
          scheduleId: "sync",
          startedAt: expect.any(String),
          status: "succeeded",
        },
      },
    })
    expect(unavailable).toEqual({
      message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation.",
      ok: false,
      status: 404,
    })
    expect(read).toMatchObject({ ok: false, status: 405 })
    expect(calls).toBe(1)
  })

  it("returns a failed run with its error and without its stack", async () => {
    installSchedules(() => {
      throw new TypeError("mailbox unavailable")
    })

    const response = await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }))

    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({
      run: {
        completedAt: expect.any(String),
        error: { message: "mailbox unavailable", name: "TypeError" },
        id: expect.stringMatching(/^srun_manual_sync_/),
        scheduleId: "sync",
        startedAt: expect.any(String),
        status: "failed",
      },
    })
  })

  it("accepts only same-origin JSON requests on the Console route", async () => {
    installSchedules()

    const form = await handleConsoleScheduleRunRequest(new Request("https://app.example/_vitehub/schedules/run", {
      body: "name=sync",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }))
    const crossOrigin = await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }, { origin: "https://attacker.example" }))
    const malformed = await handleConsoleScheduleRunRequest(new Request("https://app.example/_vitehub/schedules/run", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const sameOrigin = await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }, { origin: "https://app.example" }))

    expect([form.status, crossOrigin.status, malformed.status, sameOrigin.status]).toEqual([415, 403, 400, 200])
    expect(sameOrigin.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects oversized bodies before reading their full stream", async () => {
    let cancelled = false
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(new Uint8Array(17 * 1_024))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const request = new Request("https://app.example/_vitehub/schedules/run", {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      duplex: "half",
    } as RequestInit)

    expect((await handleConsoleScheduleRunRequest(request)).status).toBe(413)
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect((await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }, { "content-length": "16385" }))).status).toBe(413)
  })

  it("keeps the Schedule size error when stream cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(17 * 1_024)) },
      cancel() { throw new Error("cleanup failed") },
    }, { highWaterMark: 0 })
    const request = new Request("https://app.example/_vitehub/schedules/run", {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      duplex: "half",
    } as RequestInit)

    const response = await handleConsoleScheduleRunRequest(request)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ message: "Schedule run request body is too large." })
    expect(body.locked).toBe(false)
  })

  it("accepts an exact-limit streamed Schedule body and releases the reader", async () => {
    installSchedules()
    const payload = JSON.stringify({ name: "sync", label: "café 🌍" })
    const encoded = new TextEncoder().encode(payload)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(new Uint8Array([byte]))
        controller.enqueue(new TextEncoder().encode(" ".repeat(16 * 1_024 - encoded.byteLength)))
        controller.close()
      },
    })
    const request = new Request("https://app.example/_vitehub/schedules/run", {
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      duplex: "half",
    } as RequestInit)

    expect((await handleConsoleScheduleRunRequest(request)).status).toBe(200)
    expect(body.locked).toBe(false)
  })

  it("returns 404 when Console invocation did not install Schedule runs", async () => {
    installConsoleSections("/schedule-run", ["schedules"])
    installConsoleSchedules("/schedule-run", {})

    const response = await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation." })
  })
})
