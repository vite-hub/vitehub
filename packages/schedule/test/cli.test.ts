import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/internal/dev-token", async importOriginal => {
  const actual = await importOriginal<typeof import("@vite-hub/internal/dev-token")>()
  return { ...actual, readViteHubDevToken: async () => "test-schedule-token", createViteHubDevToken: async () => ({ serverId: "test-schedule-server", token: "test-schedule-token" }), removeViteHubDevToken: async () => {} }
})

import { createScheduleCliContributor, runScheduleCli } from "../src/cli.ts"
import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevRuntimeRoute, scheduleDevTokenServerHeader } from "../src/dev.ts"
import { registerScheduleDevEndpoint, scheduleDevRuntimeUnavailableMessage } from "../src/vite-dev.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ScheduleDevServer } from "../src/vite-dev.ts"

const rootDir = "/app"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

function context() {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd: rootDir, env: {}, rootDir, stderr, stdout }, stderr, stdout }
}

const digest = {
  console: { dispatch: false, visible: true },
  createdAt: "2026-05-01T00:00:00.000Z",
  cron: "0 9 * * *",
  enabled: true,
  id: "digest",
  input: { token: "[redacted]" },
  lastRun: { attemptCount: 1, id: "srun_runtime_digest_2026-05-22T09:00:00.000Z", scheduleId: "digest", scheduledAt: "2026-05-22T09:00:00.000Z", status: "succeeded", target: "report" },
  nextRunAt: "2026-05-23T09:00:00.000Z",
  target: "report",
  timeZone: "Europe/Copenhagen",
  updatedAt: "2026-05-01T00:00:00.000Z",
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro", scheduleDevTokenServerId: "test-server" }))
}

describe("vitehub schedule", () => {
  it("lists Runtime Schedules as a table and as JSON", async () => {
    const result = { automaticRuns: false, schedules: [digest] }
    const human = context()
    const fetch = devServer(result)

    await expect(runScheduleCli(["list", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "ID      TARGET  CRON                           ENABLED  NEXT RUN                  LAST RUN",
      "digest  report  0 9 * * * (Europe/Copenhagen)  yes      2026-05-23T09:00:00.000Z  succeeded 2026-05-22T09:00:00.000Z",
      "Automatic runs: off. No wake driver is installed, so due times do not start runs in this runtime.",
      "",
    ].join("\n"))
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${scheduleDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "list" }),
      headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue },
      method: "POST",
    })

    const json = context()
    await expect(runScheduleCli(["list", "--json"], json.context, { fetch: devServer(result) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(result)
  })

  it("prints one Schedule, its runs, and attempts", async () => {
    const get = context()
    await expect(runScheduleCli(["get", "digest"], get.context, { fetch: devServer({ automaticRuns: true, schedule: digest }) })).resolves.toBe(0)
    expect(get.stdout.output()).toContain("Schedule: digest\nTarget: report\n")
    expect(get.stdout.output()).toContain("Input: {\"token\":\"[redacted]\"}\n")
    expect(get.stdout.output()).toContain("Automatic runs: on.")

    const runs = context()
    const fetch = devServer({ runs: [{ ...digest.lastRun, error: { message: "Timed out" }, status: "failed" }] })
    await expect(runScheduleCli(["runs", "digest", "--limit=5"], runs.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ id: "digest", limit: 5, operation: "runs" }))
    expect(runs.stdout.output()).toContain("srun_runtime_digest_2026-05-22T09:00:00.000Z  failed  2026-05-22T09:00:00.000Z  1         Timed out")

    const attempts = context()
    await expect(runScheduleCli(["attempts", digest.lastRun.id], attempts.context, {
      fetch: devServer({ attempts: [], run: digest.lastRun }),
    })).resolves.toBe(0)
    expect(attempts.stdout.output()).toBe(`Run: ${digest.lastRun.id} (succeeded)\nNo attempts.\n`)
  })

  it("runs, enables, and disables a Schedule", async () => {
    const run = context()
    await expect(runScheduleCli(["run-runtime", "digest"], run.context, {
      fetch: devServer({ run: { ...digest.lastRun, response: { status: 204, statusText: "No Content" } } }),
    })).resolves.toBe(0)
    expect(run.stdout.output()).toBe(`Run ${digest.lastRun.id}: succeeded (HTTP 204 No Content)\n`)

    const enable = context()
    await expect(runScheduleCli(["enable", "digest"], enable.context, { fetch: devServer({ schedule: digest }) })).resolves.toBe(0)
    expect(enable.stdout.output()).toBe("Enabled Schedule digest. Next run: 2026-05-23T09:00:00.000Z.\n")

    const disable = context()
    await expect(runScheduleCli(["disable", "digest"], disable.context, {
      fetch: devServer({ schedule: { ...digest, enabled: false, nextRunAt: undefined } }),
    })).resolves.toBe(0)
    expect(disable.stdout.output()).toBe("Disabled Schedule digest.\n")
  })

  it("rejects malformed successful responses", async () => {
    const result = context()
    await expect(runScheduleCli(["list"], result.context, { fetch: devServer({ schedules: "invalid" }) })).resolves.toBe(1)
    expect(result.stderr.output()).toBe("The Schedule Dev response has an invalid result shape.\n")
  })

  it("exits with 1 when a manual run fails", async () => {
    const failed = { ...digest.lastRun, error: { message: "Target failed", name: "Error" }, status: "failed" }
    const human = context()
    await expect(runScheduleCli(["run-runtime", "digest"], human.context, { fetch: devServer({ run: failed }) })).resolves.toBe(1)
    expect(human.stdout.output()).toContain("Error: Error: Target failed\n")

    const json = context()
    await expect(runScheduleCli(["run-runtime", "digest", "--json"], json.context, { fetch: devServer({ run: failed }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual({ run: failed })
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "SCHEDULE_NOT_FOUND", message: "Runtime Schedule was not found." } }
    const human = context()
    await expect(runScheduleCli(["get", "missing"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("Runtime Schedule was not found.\n")

    const json = context()
    await expect(runScheduleCli(["get", "missing", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)
  })

  it("explains hosts that cannot reach the Schedule runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: scheduleDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runScheduleCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runScheduleCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub schedule` needs a running Vite + Nitro Development Server with `schedule` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runScheduleCli(["get"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing Schedule id.")
    const limit = context()
    await expect(runScheduleCli(["runs", "digest", "--limit", "0"], limit.context, { fetch })).resolves.toBe(1)
    expect(limit.stderr.output()).toContain("--limit must be a positive integer.")
    const unknown = context()
    await expect(runScheduleCli(["list", "--limit", "2"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --limit.")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createScheduleCliContributor().namespaces
    expect(namespace?.name).toBe("schedule")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["run", "list", "get", "runs", "attempts", "run-runtime", "enable", "disable"])
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: ScheduleDevServer = {
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: scheduleDevRoute,
  }) as unknown as IncomingMessage
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      done.emit("end")
      callback()
    },
  }), {
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
  })
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(req, res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

const guard = { [scheduleDevHeader]: scheduleDevHeaderValue }

describe("Schedule dev endpoint", () => {
  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    await registerScheduleDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Schedule Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("reports hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    await registerScheduleDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toMatchObject({ message: scheduleDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json", "x-vitehub-dev-token": "test-schedule-token", [scheduleDevTokenServerHeader]: "test-schedule-server" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    await registerScheduleDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toMatchObject({ root: rootDir, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json", "x-vitehub-dev-token": "test-schedule-token", [scheduleDevTokenServerHeader]: "test-schedule-server" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${scheduleDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(scheduleDevHeader)).toBe(scheduleDevHeaderValue)
  })
})
