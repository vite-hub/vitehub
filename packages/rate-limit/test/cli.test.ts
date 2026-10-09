import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"

import { mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRateLimitCliContributor, runRateLimitCli } from "../src/cli.ts"
import { rateLimitDevHeader, rateLimitDevHeaderValue, rateLimitDevRoute, rateLimitDevRuntimeRoute, rateLimitDevRuntimeTokenHeader } from "../src/dev.ts"
import { requireRateLimit } from "../src/index.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"
import { handleRateLimitDevRequest } from "../src/runtime/console.ts"
import { rateLimitDevRuntimeUnavailableMessage, registerRateLimitDevEndpoint } from "../src/vite-dev.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubNitroDevServer } from "@vite-hub/internal/dev-endpoint"

const rootDir = "/app"
const runtimeToken = "unit-runtime-token"
const callRuntime = (request: Request) => handleRateLimitDevRequest(request, runtimeToken)
const resetAt = Date.parse("2026-05-22T09:01:00.000Z")

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

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro" }))
}

const known = {
  counters: [{ limit: 5, remaining: 3, resetAt, used: 2, window: "1m", windowMs: 60_000 }],
  key: "192.0.2.1",
  name: "login",
  provider: "memory",
  scope: "process",
  status: "known",
}

const cloudflareReason = "The Cloudflare Rate Limiting binding exposes only limit(), which consumes a token. It cannot read or reset a counter."

describe("Rate Limit review regressions", () => {
  it.each([null, [], "malformed"])("reports malformed discovery payloads: %j", async discovery => {
    const output = context()
    const fetch = vi.fn(async () => Response.json(discovery))
    await expect(runRateLimitCli(["peek", "login", "key", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toMatchObject({ error: { message: expect.stringContaining("cannot reach the Rate Limit runtime") } })
    expect(output.stderr.output()).toBe("")
  })

  it.each(["2147483648", "4294967296"])("rejects timeout %s before discovery", async timeout => {
    const output = context()
    const fetch = vi.fn()
    await expect(runRateLimitCli(["peek", "login", "key", "--timeout", timeout, "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("at most 2147483647")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports malformed counters with flags %j", async ({ flags }) => {
    const output = context()
    await expect(runRateLimitCli(["peek", "login", "key", ...flags], output.context, { fetch: devServer({ ...known, counters: [{}] }) })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).toContain("response is invalid")
  })

  it.each(["-1", "--json"])("accepts dash-prefixed key %s after --", async (key) => {
    const output = context()
    const fetch = devServer({ ...known, key })
    await expect(runRateLimitCli(["peek", "login", "--json", "--", key], output.context, { fetch })).resolves.toBe(0)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ key })
  })

  it.each(["http://user:secret@localhost:5173", "http://user:sec/ret@localhost", "http://user:sec@ret@host:invalid", "http://user:sec ret@host:bad"])("redacts URL credentials in JSON discovery errors: %s", async url => {
    const output = context()
    await expect(runRateLimitCli(["peek", "login", "key", "--json", "--url", url], output.context, { fetch: vi.fn(async () => { throw new Error("offline") }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stdout.output()).not.toContain("secret")
    expect(output.stdout.output()).not.toContain("sec/ret")
    expect(output.stdout.output()).not.toContain("ret@host")
    expect(output.stdout.output()).not.toContain("sec ret")
    expect(output.stderr.output()).toBe("")
  })

  it.each([
    { source: "flag", json: false },
    { source: "flag", json: true },
    { source: "environment", json: false },
    { source: "environment", json: true },
  ])("redacts opaque credential URLs from $source with JSON $json", async ({ source, json }) => {
    for (const url of ["user:opaque-password@host", "mailto:user:opaque-password@host", "user:opaque/pass@host", "user:opaque password@host"]) {
      const output = context()
      if (source === "environment") Object.assign(output.context.env, { VITEHUB_DEV_SERVER_URL: url })
      const fetch = vi.fn()
      await expect(runRateLimitCli(["peek", "login", "key", ...(source === "flag" ? ["--url", url] : []), ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
      const diagnostic = output.stdout.output() + output.stderr.output()
      expect(diagnostic).toContain("[redacted]")
      expect(diagnostic).not.toContain("opaque")
      if (json) expect(output.stderr.output()).toBe("")
      else expect(output.stdout.output()).toBe("")
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it.each([
    { source: "flag", json: false },
    { source: "flag", json: true },
    { source: "environment", json: false },
    { source: "environment", json: true },
  ])("redacts secret query parameters from $source with JSON $json", async ({ source, json }) => {
    const url = "http://localhost:5173/?token=hidden-token&token=hidden-repeat&credential=hidden-adjacent&api_key=hidden-api&password=hidden-password&credential=hidden-credential&private_key=hidden-private&authorization=hidden-auth&cookie=hidden-cookie&signature=hidden-signature&dsn=hidden-dsn&connection_string=hidden-connection&%74oken=hidden-encoded&mode=inspect"
    const output = context()
    if (source === "environment") Object.assign(output.context.env, { VITEHUB_DEV_SERVER_URL: url })
    const fetch = vi.fn(async () => { throw new Error("offline") })
    await expect(runRateLimitCli(["peek", "login", "key", ...(source === "flag" ? ["--url", url] : []), ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
    const diagnostic = output.stdout.output() + output.stderr.output()
    expect(diagnostic).not.toContain("hidden-")
    expect(diagnostic).toContain("[redacted]")
    expect(diagnostic).toContain("mode=inspect")
    expect(fetch).toHaveBeenCalledOnce()
    if (json) expect(output.stderr.output()).toBe("")
    else expect(output.stdout.output()).toBe("")
  })

  it.each([false, true])("redacts secret queries alongside opaque or invalid credentials with JSON %s", async json => {
    for (const url of ["user:opaque-password@host?token=hidden-token", "http://user:opaque-password@host:bad?token=hidden-token"]) {
      const output = context()
      const fetch = vi.fn()
      await expect(runRateLimitCli(["peek", "login", "key", "--url", url, ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
      const diagnostic = output.stdout.output() + output.stderr.output()
      expect(diagnostic).not.toContain("hidden-token")
      expect(diagnostic).not.toContain("opaque-password")
      expect(diagnostic).toContain("[redacted]")
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])("redacts credentials in argument failures with JSON %s", async json => {
    for (const argument of ["--token=sk_live_secret", "--api-key=hidden-key", "token=hidden-token", "Bearer hidden-bearer", "http://user:hidden-password@host"]) {
      const output = context()
      const fetch = vi.fn()
      await expect(runRateLimitCli(["peek", "login", "key", argument, ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
      const diagnostic = output.stdout.output() + output.stderr.output()
      expect(diagnostic).not.toContain("sk_live_secret")
      expect(diagnostic).not.toContain("hidden-")
      expect(diagnostic).toContain("[redacted]")
      if (json) { expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message"); expect(output.stderr.output()).toBe("") }
      else expect(output.stdout.output()).toBe("")
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it("redacts credentials in unknown command names", async () => {
    const output = context()
    const fetch = vi.fn()
    await expect(runRateLimitCli(["token=hidden-command"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("token=[redacted]")
    expect(output.stderr.output()).not.toContain("hidden-command")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([false, true])("redacts provider errors and preserves the error code with JSON %s", async json => {
    const output = context()
    const fetch = devServer({ error: { code: "PROVIDER_OFFLINE", message: "token=hidden-provider" } }, { status: 500 })
    await expect(runRateLimitCli(["peek", "login", "key", ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).not.toContain("hidden-provider")
    if (json) expect(JSON.parse(output.stdout.output())).toEqual({ error: { code: "PROVIDER_OFFLINE", message: "token=[redacted]" } })
    else expect(output.stderr.output()).toBe("token=[redacted]\n")
  })

  it.each([false, true])("redacts mismatched discovery roots with JSON %s", async json => {
    for (const root of ["/tmp/token=hidden-root", "/tmp/api_key=hidden-api", "Bearer hidden-bearer", "http://user:hidden-password@host"]) {
      const output = context()
      const fetch = devServer(known, { discovery: { root, runtime: "nitro" } })
      await expect(runRateLimitCli(["peek", "login", "key", ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
      const diagnostic = output.stdout.output() + output.stderr.output()
      expect(diagnostic).toContain("root mismatch")
      expect(diagnostic).toContain("[redacted]")
      expect(diagnostic).not.toContain("hidden-")
      if (json) { expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message"); expect(output.stderr.output()).toBe("") }
      else expect(output.stdout.output()).toBe("")
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it.each([false, true])("redacts whitespace credentials from environment URL with JSON %s", async json => {
    const output = context()
    Object.assign(output.context.env, { VITEHUB_DEV_SERVER_URL: "http://user:sec ret@host:bad" })
    await expect(runRateLimitCli(["peek", "login", "key", ...(json ? ["--json"] : [])], output.context, { fetch: vi.fn() })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).not.toContain("sec ret")
    expect(output.stdout.output() + output.stderr.output()).toContain("[redacted]")
  })

  it.each([false, true])("handles interrupted error-response bodies with JSON %s", async json => {
    const output = context()
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("body interrupted")) } }), { status: 500 })
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json({ root: rootDir, runtime: "nitro" }))
    await expect(runRateLimitCli(["peek", "login", "key", ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
    if (json) {
      expect(JSON.parse(output.stdout.output()).error.message).toContain("body interrupted")
      expect(output.stderr.output()).toBe("")
    }
    else {
      expect(output.stderr.output()).toContain("body interrupted")
      expect(output.stdout.output()).toBe("")
    }
  })

  it("applies timeout to discovery", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runRateLimitCli(["peek", "login", "key", "--json", "--timeout", "10"], output.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([true, "0.0.0.0", "::", "192.0.2.1"])("refuses non-loopback server host %s", (host) => {
    const { server, middlewares } = fakeServer()
    server.config.server.host = host
    expect(() => registerRateLimitDevEndpoint(server, { runtimeToken })).toThrow("loopback-only")
    expect(middlewares).toHaveLength(0)
  })
})

describe("vitehub rate-limit", () => {
  it("prints the counter of one key as a table and as JSON", async () => {
    const human = context()
    const fetch = devServer(known)

    await expect(runRateLimitCli(["peek", "login", "192.0.2.1", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "Rate Limit login, key 192.0.2.1",
      "Provider: memory",
      "Scope: process. The counter exists only in this server process.",
      "LIMIT  WINDOW  USED  REMAINING  RESETS AT",
      "5      1m      2     3          2026-05-22T09:01:00.000Z",
      "",
    ].join("\n"))
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${rateLimitDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ key: "192.0.2.1", name: "login", operation: "peek" }),
      headers: { "content-type": "application/json", [rateLimitDevHeader]: rateLimitDevHeaderValue },
      method: "POST",
    })

    const json = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1", "--json"], json.context, { fetch: devServer(known) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(known)
  })

  it("prints an unused counter and a reset", async () => {
    const unused = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1"], unused.context, {
      fetch: devServer({ key: "192.0.2.1", name: "login", provider: "memory", reason: "No request used this Rate Limit.", status: "unused" }),
    })).resolves.toBe(0)
    expect(unused.stdout.output()).toBe("Rate Limit login, key 192.0.2.1\nProvider: memory\nNo counter: No request used this Rate Limit.\n")

    const reset = context()
    const fetch = devServer({ key: "192.0.2.1", name: "login", provider: "memory", scope: "process", status: "reset" })
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1"], reset.context, { fetch })).resolves.toBe(0)
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ key: "192.0.2.1", name: "login", operation: "reset" }))
    expect(reset.stdout.output()).toBe([
      "Reset Rate Limit login for key 192.0.2.1.",
      "Provider: memory",
      "Scope: process. The counter exists only in this server process.",
      "",
    ].join("\n"))
  })

  it("exits with 1 when the provider cannot read or reset the counter", async () => {
    const unsupported = { key: "192.0.2.1", name: "login", provider: "cloudflare", reason: cloudflareReason, status: "unsupported" }
    const peek = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1"], peek.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(peek.stdout.output()).toBe(`Rate Limit login, key 192.0.2.1\nProvider: cloudflare\nCounter unknown: ${cloudflareReason}\n`)

    const reset = context()
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1"], reset.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(reset.stdout.output()).toBe(`Rate Limit login, key 192.0.2.1\nProvider: cloudflare\nNot reset: ${cloudflareReason}\n`)

    const json = context()
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1", "--json"], json.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(unsupported)
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { message: "[vitehub] Rate Limit key must be a non-empty string." } }
    const human = context()
    await expect(runRateLimitCli(["peek", "login", "x"], human.context, { fetch: devServer(failure, { status: 500 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("[vitehub] Rate Limit key must be a non-empty string.\n")

    const json = context()
    await expect(runRateLimitCli(["peek", "login", "x", "--json"], json.context, { fetch: devServer(failure, { status: 500 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)
  })

  it("explains hosts that cannot reach the Rate Limit runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: rateLimitDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "RATE_LIMIT_DEV_RUNTIME_UNAVAILABLE", message: rateLimitDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1"], missing.context, {
      fetch: vi.fn(async () => new Response("Not found", { status: 404 })),
    })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub rate-limit` needs a running Vite + Nitro Development Server with `rateLimit` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runRateLimitCli(["peek"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing Rate Limit ID.")
    expect(missingId.stderr.output()).toContain("Usage: vitehub rate-limit peek <id> <key> [--json] [--url <url>]")
    const missingKey = context()
    await expect(runRateLimitCli(["reset", "login"], missingKey.context, { fetch })).resolves.toBe(1)
    expect(missingKey.stderr.output()).toContain("Missing Rate Limit key.")
    const extra = context()
    await expect(runRateLimitCli(["peek", "login", "a", "b"], extra.context, { fetch })).resolves.toBe(1)
    expect(extra.stderr.output()).toContain("Unexpected argument: b.")
    const unknown = context()
    await expect(runRateLimitCli(["peek", "login", "a", "--limit", "2"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --limit.")
    const command = context()
    await expect(runRateLimitCli(["consume", "login", "a"], command.context, { fetch })).resolves.toBe(1)
    expect(command.stderr.output()).toBe("Unknown rate-limit command: consume\nCommands: peek, reset\n")
    const help = context()
    await expect(runRateLimitCli(["reset", "--help"], help.context, { fetch })).resolves.toBe(0)
    expect(help.stdout.output()).toContain("Usage: vitehub rate-limit reset <id> <key>")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createRateLimitCliContributor().namespaces
    expect(namespace?.name).toBe("rate-limit")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["peek", "reset"])
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: ViteHubNitroDevServer = {
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string, peer?: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    socket: { remoteAddress: init.peer ?? "127.0.0.1" },
    url: rateLimitDevRoute,
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

const guard = { [rateLimitDevHeader]: rateLimitDevHeaderValue }

describe("Rate Limit dev endpoint", () => {
  it.each(["allowedHosts", "https"])("rejects DNS-rebinding hosts even when Vite enables %s", async option => {
    const dispatchFetch = vi.fn(async () => Response.json({}))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    Object.assign(server.config.server, option === "allowedHosts" ? { allowedHosts: true } : { https: {} })
    registerRateLimitDevEndpoint(server, { runtimeToken })
    const response = await call(middlewares[0]!, { method: "POST", body: "{}", headers: { ...guard, "content-type": "application/json", host: "attacker.test:5173", origin: "http://attacker.test:5173" } })
    expect(response.status).toBe(403)
    expect(response.body).toContain("loopback host")
    expect(dispatchFetch).not.toHaveBeenCalled()
  })

  it("rejects a remote peer even with forged localhost headers", async () => {
    const { middlewares, server } = fakeServer()
    registerRateLimitDevEndpoint(server, { runtimeToken })
    const response = await call(middlewares[0]!, { headers: guard, method: "GET", peer: "192.0.2.1" })
    expect(response.status).toBe(403)
    expect(response.body).toContain("loopback peer")
  })

  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    registerRateLimitDevEndpoint(server, { runtimeToken })

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Rate Limit Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("returns 501 on hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerRateLimitDevEndpoint(server, { runtimeToken })

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: rateLimitDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"peek\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "RATE_LIMIT_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerRateLimitDevEndpoint(server, { runtimeToken, nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: rootDir, runtime: "nitro" })
    const body = "{\"key\":\"a\",\"name\":\"login\",\"operation\":\"peek\"}"
    const operation = await call(middlewares[0]!, { body, headers: { ...guard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(JSON.parse(operation.body)).toEqual({ body, url: `http://localhost/app${rateLimitDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(rateLimitDevHeader)).toBe(rateLimitDevHeaderValue)
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(rateLimitDevRuntimeTokenHeader)).toBe(runtimeToken)
  })
})

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request(`http://localhost${rateLimitDevRuntimeRoute}`, {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [rateLimitDevHeader]: rateLimitDevHeaderValue, [rateLimitDevRuntimeTokenHeader]: runtimeToken, ...init.headers },
    method,
  })
}

describe("Rate Limit dev handler", () => {
  afterEach(() => {
    vi.useRealTimers()
    setRateLimitRuntimeConfig({ provider: "memory" })
  })

  it.each([undefined, "forged-token"])("rejects direct runtime requests with token %j", async (token) => {
    const request = devRequest({ key: "key", name: "login", operation: "reset" })
    request.headers.delete(rateLimitDevRuntimeTokenHeader)
    if (token) request.headers.set(rateLimitDevRuntimeTokenHeader, token)
    expect((await callRuntime(request)).status).toBe(403)
  })

  it("rejects unguarded, cross-origin, and invalid requests", async () => {
    expect((await callRuntime(devRequest({}, { headers: { [rateLimitDevHeader]: "" } }))).status).toBe(403)
    expect((await callRuntime(devRequest({}, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await callRuntime(devRequest({}, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await callRuntime(devRequest(undefined, { method: "DELETE" }))).status).toBe(405)
    for (const body of ["not json", { key: "a", name: "login", operation: "consume" }, { key: "", name: "login", operation: "peek" }, { key: "a", name: " ", operation: "reset" }]) {
      const response = await callRuntime(devRequest(body))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: { message: "The Rate Limit Dev request body is invalid." } })
    }
  })

  it("reads and resets the counters of requireRateLimit() without consuming a token", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse("2026-05-22T09:00:30.000Z"))
    setRateLimitRuntimeConfig({ provider: "memory" })
    const event = mockEvent("https://example.com/login")
    Object.assign(event.req, { ip: "192.0.2.10" })
    await requireRateLimit(event, "cli-login", { limit: 5, window: "1m" })

    const peek = await callRuntime(devRequest({ key: "192.0.2.10", name: "cli-login", operation: "peek" }))
    expect(peek.headers.get("cache-control")).toBe("no-store")
    await expect(peek.json()).resolves.toEqual({
      counters: [{ limit: 5, remaining: 4, resetAt, used: 1, window: "1m", windowMs: 60_000 }],
      key: "192.0.2.10",
      name: "cli-login",
      provider: "memory",
      scope: "process",
      status: "known",
    })
    const again = await callRuntime(devRequest({ key: "192.0.2.10", name: "cli-login", operation: "peek" }))
    await expect(again.json()).resolves.toMatchObject({ counters: [{ used: 1 }] })

    const reset = await callRuntime(devRequest({ key: "192.0.2.10", name: "cli-login", operation: "reset" }))
    await expect(reset.json()).resolves.toEqual({ key: "192.0.2.10", name: "cli-login", provider: "memory", scope: "process", status: "reset" })
    const after = await callRuntime(devRequest({ key: "192.0.2.10", name: "cli-login", operation: "peek" }))
    await expect(after.json()).resolves.toMatchObject({ counters: [{ remaining: 5, used: 0 }] })
  })

  it("redacts credentials in the echoed key", async () => {
    const response = await callRuntime(devRequest({ key: "Bearer sk-live-secret", name: "api", operation: "peek" }))
    const body = await response.json()
    expect(body).toMatchObject({ key: "Bearer [redacted]", status: "unused" })
    expect(JSON.stringify(body)).not.toContain("sk-live-secret")
  })

  it("reports that the Cloudflare provider cannot read or reset counters", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    for (const operation of ["peek", "reset"]) {
      const response = await callRuntime(devRequest({ key: "192.0.2.1", name: "login", operation }))
      await expect(response.json()).resolves.toEqual({ key: "192.0.2.1", name: "login", provider: "cloudflare", reason: cloudflareReason, status: "unsupported" })
    }
  })
})
