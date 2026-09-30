import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { createRpcClient } from "devframe/rpc/client"
import { createSseRpcChannel } from "devframe/rpc/transports/sse-client"
import { afterEach, describe, expect, it } from "vitest"

import { defineSchedule } from "@vite-hub/schedule"
import { resetScheduleRuntime } from "@vite-hub/schedule/runtime"

import { consoleDefinitionsKey, consoleDefinitionsRegistryKey, consoleDefinitionsRootKey, consoleSchedulesKey, consoleSchedulesRegistryKey, consoleSchedulesRootKey, consoleSectionsKey, consoleSectionsRegistryKey, consoleSectionsRootKey } from "../src/console/internal.ts"
import { discoverConsoleBuildCatalog } from "../src/console/build.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import definitionsHandler from "../src/console/runtime/server/definitions.get.ts"
import { installConsoleDefinitions, installConsoleSchedules } from "../src/console/runtime/server/definitions.ts"
import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"
import { handleConsoleScheduleRunRequest } from "../src/console/runtime/server/schedule-run.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRpcFunctions } from "../src/console/runtime/rpc.ts"

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
  installConsoleDefinitions("/schedule-run", { schedules: [scheduleSummary("sync"), scheduleSummary("nightly")] })
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
    const catalog = { agents: [], definitions: { schedules: [scheduleSummary("sync")] }, manualSchedules: [{ handler, name: "sync" }] }

    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], [], undefined, undefined, true)
    const invokeEnabled = await readFile(plugin, "utf8")
    await writeConsoleNitroPlugin(plugin, root, ["schedules"], [], catalog, [], [])
    const invokeDisabled = await readFile(plugin, "utf8")

    expect(invokeEnabled).toContain(`import { installConsoleDefinitions, installConsoleSchedules } from "vite-hub/console/definitions"`)
    expect(invokeEnabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, { ["sync"]: () => import(${JSON.stringify(pathToFileURL(handler).href)}) })`)
    expect(invokeDisabled).toContain(`installConsoleSchedules(${JSON.stringify(root)}, {})`)
    expect(invokeDisabled).not.toContain(pathToFileURL(handler).href)
  })

  it("discovers manual Static Schedule Definitions for the Console", async () => {
    const root = await temporaryRoot("vitehub-console-schedule-catalog-")
    await mkdir(join(root, "server/schedules"), { recursive: true })
    await writeFile(join(root, "server/schedules/sync.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '*/5 * * * *', manual: true, handler() {} })\n")
    await writeFile(join(root, "server/schedules/nightly.ts"), "import { defineSchedule } from 'vite-hub/schedule'\nexport default defineSchedule({ cron: '0 3 * * *', handler() {} })\n")

    const catalog = await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot: root, sections: ["schedules"] })

    expect(catalog.manualSchedules).toEqual([{ handler: join(root, "server/schedules/sync.ts"), name: "sync" }])
  })

  it("marks runnable Schedule Definitions in the catalog", () => {
    installSchedules()

    expect(definitionsHandler({ method: "GET", req: { method: "GET", url: "http://localhost/api/_vitehub/console/definitions?section=schedules" } })).toEqual({
      definitions: [{ ...scheduleSummary("sync"), runnable: true }, scheduleSummary("nightly")],
      section: "schedules",
    })
  })

  it("runs a Schedule through the Console RPC operation", async () => {
    let calls = 0
    installSchedules(() => { calls++ })
    const handler = createConsoleDevframeHandler()
    const channel = createSseRpcChannel({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
        return (await handler({ method: request.method, req: request } as never)) as Response
      },
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<ConsoleRpcFunctions>({}, { channel })

    try {
      const run = await client.$call(consoleRpcMethods.scheduleRun, { body: { name: "sync" }, method: "POST" })
      const unavailable = await client.$call(consoleRpcMethods.scheduleRun, { body: { name: "nightly" }, method: "POST" })
      const read = await client.$call(consoleRpcMethods.scheduleRun, { method: "GET" })

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
    }
    finally {
      channel.close()
      await handler.close()
    }
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

  it("returns 404 when Console invocation did not install Schedule runs", async () => {
    installConsoleSections("/schedule-run", ["schedules"])
    installConsoleSchedules("/schedule-run", {})

    const response = await handleConsoleScheduleRunRequest(runRequest({ name: "sync" }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation." })
  })
})
