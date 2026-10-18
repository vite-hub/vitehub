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

const lastRun = { attemptCount: 1, id: "srun_static_digest_2026-05-22T09:00:00.000Z", scheduleId: "digest", scheduledAt: "2026-05-22T09:00:00.000Z", status: "succeeded", target: "digest" }

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro", scheduleDevTokenServerId: "test-server" }))
}

describe("vitehub schedule", () => {
  it("prints the runs of one Schedule and the attempts of one run", async () => {
    const runs = context()
    const fetch = devServer({ runs: [{ ...lastRun, error: { message: "Timed out" }, status: "failed" }] })
    await expect(runScheduleCli(["runs", "digest", "--limit=5", "--url", "http://127.0.0.1:4321"], runs.context, { fetch })).resolves.toBe(0)
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${scheduleDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ id: "digest", limit: 5, operation: "runs" }),
      headers: { "content-type": "application/json", [scheduleDevHeader]: scheduleDevHeaderValue },
      method: "POST",
    })
    expect(runs.stdout.output()).toContain("srun_static_digest_2026-05-22T09:00:00.000Z  failed  2026-05-22T09:00:00.000Z  1         Timed out")

    const json = context()
    const result = { runs: [lastRun] }
    await expect(runScheduleCli(["runs", "digest", "--json"], json.context, { fetch: devServer(result) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(result)

    const attempts = context()
    await expect(runScheduleCli(["attempts", lastRun.id], attempts.context, {
      fetch: devServer({ attempts: [], run: lastRun }),
    })).resolves.toBe(0)
    expect(attempts.stdout.output()).toBe(`Run: ${lastRun.id} (succeeded)\nNo attempts.\n`)
  })

  it("rejects malformed successful responses", async () => {
    const result = context()
    await expect(runScheduleCli(["runs", "digest"], result.context, { fetch: devServer({ runs: "invalid" }) })).resolves.toBe(1)
    expect(result.stderr.output()).toBe("The Schedule Dev response has an invalid result shape.\n")
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "SCHEDULE_RUN_NOT_FOUND", message: "Schedule Run was not found." } }
    const human = context()
    await expect(runScheduleCli(["attempts", "missing"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("Schedule Run was not found.\n")

    const json = context()
    await expect(runScheduleCli(["attempts", "missing", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)
  })

  it("rejects removed Runtime Schedule commands", async () => {
    for (const name of ["list", "get", "run-runtime", "enable", "disable"]) {
      const removed = context()
      await expect(runScheduleCli([name, "digest"], removed.context, { fetch: vi.fn() })).resolves.toBe(1)
      expect(removed.stderr.output()).toBe(`Unknown schedule command: ${name}\nCommands: run, runs, attempts\n`)
    }
  })

  it("explains hosts that cannot reach the Schedule runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: scheduleDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runScheduleCli(["runs", "digest", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE", message: scheduleDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runScheduleCli(["runs", "digest"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub schedule` needs a running Vite + Nitro Development Server with `schedule` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runScheduleCli(["runs"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing Schedule Definition name.")
    const missingRun = context()
    await expect(runScheduleCli(["attempts"], missingRun.context, { fetch })).resolves.toBe(1)
    expect(missingRun.stderr.output()).toContain("Missing Schedule Run id.")
    const limit = context()
    await expect(runScheduleCli(["runs", "digest", "--limit", "0"], limit.context, { fetch })).resolves.toBe(1)
    expect(limit.stderr.output()).toContain("--limit must be a positive integer.")
    const unknown = context()
    await expect(runScheduleCli(["attempts", "srun_1", "--limit", "2"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --limit.")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createScheduleCliContributor().namespaces
    expect(namespace?.name).toBe("schedule")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["run", "runs", "attempts"])
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
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"runs\",\"id\":\"digest\"}", headers: { ...guard, "content-type": "application/json", "x-vitehub-dev-token": "test-schedule-token", [scheduleDevTokenServerHeader]: "test-schedule-server" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    await registerScheduleDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toMatchObject({ root: rootDir, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"runs\",\"id\":\"digest\"}", headers: { ...guard, "content-type": "application/json", "x-vitehub-dev-token": "test-schedule-token", [scheduleDevTokenServerHeader]: "test-schedule-server" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"runs\",\"id\":\"digest\"}", url: `http://localhost/app${scheduleDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(scheduleDevHeader)).toBe(scheduleDevHeaderValue)
  })
})
