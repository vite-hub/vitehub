import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { H3Event } from "h3"
import { afterEach, describe, expect, it } from "vitest"

import { defineSchedule } from "@vite-hub/schedule"
import { scheduleOperations } from "@vite-hub/schedule/operations"
import { resetScheduleRuntime } from "@vite-hub/schedule/runtime"
import { resolveViteHubDispatchKey, signViteHubDispatch } from "@vite-hub/internal/dispatch"

import { consoleDefinitionsKey, consoleDefinitionsRegistryKey, consoleDefinitionsRootKey, consoleSchedulesKey, consoleSchedulesRegistryKey, consoleSchedulesRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import definitionsHandlerRoute from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions, installConsoleSchedules } from "../src/console/runtime/server/definitions.ts"
import scheduleRunRoute, { handleDispatchScheduleRunRequest } from "../src/console/runtime/server/schedule-run.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"
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
  installConsoleOperations([])
})

const scheduleSummary = (name: string) => ({
  fields: [{ label: "Kind", value: "Static schedule" }],
  file: `server/schedules/${name}.ts`,
  name,
  source: "server-schedules",
})

function installSchedules(handler: () => unknown = () => {}) {
  installConsoleOperations([{ operations: scheduleOperations, plugin: "@vite-hub/schedule/vite" }])
  installConsoleSections("/schedule-run", ["schedules"])
  installConsoleDefinitions("/schedule-run", { schedules: { definitions: [scheduleSummary("sync"), scheduleSummary("nightly")], kind: "definition-catalog" } })
  installConsoleSchedules("/schedule-run", {
    sync: async () => ({ default: defineSchedule("*/5 * * * *", handler, { manual: true }) }),
  })
}

async function call(operation: string, input: Record<string, unknown>): Promise<unknown> {
  const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }))
  return response.json()
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

    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], undefined, undefined, true)
    const invokeEnabled = await readFile(plugin, "utf8")
    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [])
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

    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], undefined, undefined, true)

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
    // The Schedule package writes these cells for each Schedule Definition record.
    const records = ["definition:sync", "definition:nightly", "other:sync"].map(id => ({
      cells: { manual: "Yes", schedule: id.split(":")[1]!, timing: "0 9 * * *" },
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
          startedAt: expect.any(String),
          status: "failed",
        },
      },
    })
  })

  it("runs a signed dispatch request without a Console session and rejects a replay or a bad signature", async () => {
    installSchedules()
    const env = { VITEHUB_SECRET: "dispatch-root-secret-at-least-32-characters" }
    const body = JSON.stringify({ name: "sync" })
    const key = await resolveViteHubDispatchKey(env)
    const headers = { "content-type": "application/json", ...await signViteHubDispatch({ actor: "ci", body, key: key!, operation: "schedule.run" }) }
    const request = () => new Request("https://app.example/_vitehub/schedules/run", { body, headers, method: "POST" })

    const signed = await handleDispatchScheduleRunRequest(request(), env)
    const replay = await handleDispatchScheduleRunRequest(request(), env)
    const otherDeployment = await handleDispatchScheduleRunRequest(request(), { VITEHUB_SECRET: "another-root-secret-at-least-32-characters" })

    expect(signed.status).toBe(200)
    expect(await signed.json()).toMatchObject({ run: { scheduleId: "sync", status: "succeeded" } })
    expect([replay.status, otherDeployment.status]).toEqual([401, 401])
    expect(await replay.json()).toEqual({ message: "Dispatch nonce was already used." })
  })

  it("uses the request Cloudflare environment for the generated route", async () => {
    installSchedules()
    const env = { VITEHUB_SECRET: "cloudflare-dispatch-secret-at-least-32-characters" }
    const body = JSON.stringify({ name: "sync" })
    const key = await resolveViteHubDispatchKey(env)
    const headers = { "content-type": "application/json", ...await signViteHubDispatch({ actor: "worker", body, key: key!, operation: "schedule.run" }) }
    const response = await scheduleRunRoute(new H3Event(
      new Request("https://app.example/_vitehub/schedules/run", { body, headers, method: "POST" }),
      { cloudflare: { env } },
    ))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ run: { scheduleId: "sync", status: "succeeded" } })
  })

  it("never falls back to Console access for a request with a dispatch signature", async () => {
    installSchedules()
    const response = await scheduleRunRoute(Object.assign(Object.create(null), {
      req: runRequest({ name: "sync" }, { "x-vitehub-dispatch-signature": "v1=forged" }),
    }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: expect.stringMatching(/Dispatch is not configured|Malformed dispatch signature/) })
  })

  it("takes only signed dispatches on the route, and sends everyone else to the operation", async () => {
    installSchedules()
    const response = await scheduleRunRoute(Object.assign(Object.create(null), { req: runRequest({ name: "sync" }) }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: expect.stringContaining("vitehub schedule run") })
  })

  it("rejects non-JSON, malformed, and oversized dispatch bodies before reading their full stream", async () => {
    const env = { VITEHUB_SECRET: "dispatch-root-secret-at-least-32-characters" }
    const form = await handleDispatchScheduleRunRequest(new Request("https://app.example/_vitehub/schedules/run", {
      body: "name=sync",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }), env)
    expect(form.status).toBe(415)

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

    const response = await handleDispatchScheduleRunRequest(request, env)
    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ message: "Schedule run request body is too large." })
    expect(reads).toBe(1)
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
    expect((await handleDispatchScheduleRunRequest(runRequest({ name: "sync" }, { "content-length": "16385" }), env)).status).toBe(413)
  })

  it("accepts an exact-limit streamed dispatch body and releases the reader", async () => {
    installSchedules()
    const env = { VITEHUB_SECRET: "dispatch-root-secret-at-least-32-characters" }
    const payload = JSON.stringify({ name: "sync", label: "café 🌍" })
    const text = payload + " ".repeat(16 * 1_024 - new TextEncoder().encode(payload).byteLength)
    const key = await resolveViteHubDispatchKey(env)
    const encoded = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.byteLength; offset += 512) controller.enqueue(encoded.slice(offset, offset + 512))
        controller.close()
      },
    })
    const request = new Request("https://app.example/_vitehub/schedules/run", {
      body,
      headers: { "content-type": "application/json", ...await signViteHubDispatch({ actor: "ci", body: text, key: key!, operation: "schedule.run" }) },
      method: "POST",
      duplex: "half",
    } as RequestInit)

    expect((await handleDispatchScheduleRunRequest(request, env)).status).toBe(200)
    expect(body.locked).toBe(false)
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
