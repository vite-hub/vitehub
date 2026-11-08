import { createServer, request as httpRequest } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"

import { readViteHubDevToken } from "@vite-hub/internal/dev-token"
import { afterEach, describe, expect, it } from "vitest"

import { connectSetup } from "../src/console/runtime/client/setup.ts"
import { setConsoleProject } from "../src/console/runtime/client/project.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment, installConsoleOperations, installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { isSetupDevRequestAllowed, setupDevPlugin, setupDevRoute, setupDevTokenNamespace } from "../src/setup-dev.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { SetupCommandRunner } from "@vite-hub/cli/setup"
import type { ViteDevServer } from "vite"

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

interface Running {
  calls: { args: readonly string[], command: string, cwd: string }[]
  close: () => Promise<void>
  port: number
  root: string
  serverId: string
  token: string
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async cleanup => await cleanup()))
})

/** The Setup plugin on a minimal dev server: the parts of a Vite server that `registerViteHubDevEndpoint` uses. */
async function start(allowedHosts: readonly string[] | true = [], listenHost = "127.0.0.1", base = ""): Promise<Running> {
  installConsoleAccess({ mode: "open" })
  installConsoleDevelopment("/test/setup-dev", true, setupDevRoute)
  installConsoleSections("/test/setup-dev", ["setup"])
  installConsoleOperations()
  const root = await mkdtemp(join(tmpdir(), "vitehub-setup-dev-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "app", packageManager: "pnpm@10.0.0", type: "module" }))
  await writeFile(join(root, "vite.config.ts"), "import { defineConfig } from \"vite\"\nimport { vitehub } from \"vite-hub\"\n\nexport default defineConfig({\n  plugins: [vitehub({ preset: \"node\" })],\n})\n")
  const calls: Running["calls"] = []
  const run: SetupCommandRunner = async (command, args, options) => {
    calls.push({ args, command, cwd: options.cwd })
    options.onOutput("fake install\n", "stdout")
    return { exitCode: 0 }
  }
  const middlewares: Middleware[] = []
  let closed = false
  const fake = {
    close: async () => { closed = true },
    config: { base, root, server: { allowedHosts } },
    middlewares: { use: (handler: Middleware) => middlewares.push(handler) },
    resolvedUrls: { local: ["http://localhost:5173/"] },
  }
  const plugin = setupDevPlugin({ run })
  const hook = plugin.configureServer
  if (typeof hook !== "function") throw new TypeError("Expected a configureServer hook.")
  // SAFETY: The plugin reads only `config.root`, `config.server`, `middlewares`, `resolvedUrls`, and `close`.
  await hook.call(undefined as never, fake as unknown as ViteDevServer)
  const http: Server = createServer((req, res) => {
    if (req.url === `${base}/_vitehub/rpc/__call`) {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const request = new Request(`http://${req.headers.host}${req.url}`, {
          body: Buffer.concat(chunks),
          headers: Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])),
          method: "POST",
        })
        const response = await handleConsoleRpcRequest(request)
        res.statusCode = response.status
        res.end(await response.text())
      })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined))
      return
    }
    const next = (index: number): void => {
      const handler = middlewares[index]
      if (!handler) {
        res.statusCode = 404
        res.end("not found")
        return
      }
      handler(req, res, () => next(index + 1))
    }
    next(0)
  })
  await new Promise<void>(done => http.listen(0, listenHost, done))
  const address = http.address()
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  const session = await send(address.port, "GET", "session", { "sec-fetch-site": "same-origin", "x-vitehub-setup": "session" })
  const { serverId, token } = JSON.parse(session.body) as { serverId: string, token: string }
  const close = async () => {
    if (!closed) await fake.close()
    await new Promise<void>(done => http.close(() => done()))
    await rm(root, { force: true, recursive: true })
  }
  cleanups.push(close)
  return { calls, close, port: address.port, root, serverId, token }
}

/** One HTTP request with exact headers. `fetch` cannot send a custom `Host`. */
async function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown, connectHost = "127.0.0.1"): Promise<{ body: string, status: number }> {
  return await new Promise((done, fail) => {
    const req = httpRequest({ headers: { host: `localhost:${port}`, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, host: connectHost, method, path: `${setupDevRoute}/${path}`, port }, (res) => {
      let text = ""
      res.setEncoding("utf8").on("data", (chunk: string) => { text += chunk }).on("end", () => done({ body: text, status: res.statusCode ?? 0 }))
    })
    req.once("error", fail)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function auth(running: Running, headers: Record<string, string> = {}): Record<string, string> {
  return { "x-vitehub-dev-token": running.token, ...headers }
}

describe("dev Setup endpoints", () => {
  it.each(["", "/portal"])("checks the current Console grant before direct HTTP writes (mount: '%s')", async (base) => {
    const running = await start([], "127.0.0.1", base)
    const before = await readFile(join(running.root, "vite.config.ts"), "utf8")
    let sections = ["setup:read"]
    const credentials: string[] = []
    installConsoleAccess({ mode: "open", authorize: ({ request }) => {
      credentials.push(request.headers.get("cookie") ?? "")
      return { sections }
    } })
    const headers = auth(running, { cookie: "session=reader" })
    const planned = await send(running.port, "POST", "plan", headers, { action: "add", features: ["kv"] })
    expect(planned.status).toBe(200)
    const { planId } = JSON.parse(planned.body) as { planId: string }
    expect(await send(running.port, "POST", "apply", headers, { planId })).toMatchObject({ status: 403 })
    expect(await readFile(join(running.root, "vite.config.ts"), "utf8")).toBe(before)
    expect(running.calls).toEqual([])
    sections = ["kv"]
    expect(await send(running.port, "POST", "apply", headers, { planId })).toMatchObject({ status: 403 })
    sections = ["setup"]
    expect(await send(running.port, "POST", "apply", headers, { planId })).toMatchObject({ status: 200 })
    expect(await readFile(join(running.root, "vite.config.ts"), "utf8")).toContain("kv: true")
    expect(credentials).toEqual(["session=reader", "session=reader", "session=reader"])
  })

  it("passes the Console client's bearer credential to the write access check", async () => {
    const running = await start()
    installConsoleAccess({
      mode: "auth",
      check: async event => event.req?.headers instanceof Headers && event.req.headers.get("authorization") === "Bearer writer"
        ? undefined
        : new Response("Sign in.", { status: 401 }),
      authorize: () => ({ sections: ["setup"] }),
    })
    setConsoleProject({ origin: "", base: "", authorization: () => "Bearer writer" })
    try {
      const client = await connectSetup(`http://127.0.0.1:${running.port}${setupDevRoute}`)
      const planned = await client.plan({ action: "add", features: ["kv"] })
      expect(await client.apply(planned.planId!)).toMatchObject({ status: "applied" })
    }
    finally {
      setConsoleProject({ origin: "", base: "" })
    }
  })

  it("connects the Console client without Fetch Metadata", async () => {
    const running = await start()
    const client = await connectSetup(`http://127.0.0.1:${running.port}${setupDevRoute}`)
    expect(client.serverId).toBe(running.serverId)
    expect(await client.status()).toMatchObject({ root: running.root })
  })

  it("rejects a foreign Origin and a DNS rebinding Host with 403", async () => {
    const running = await start()
    expect(await send(running.port, "GET", "status", auth(running, { origin: "https://evil.example" }))).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "status", auth(running, { host: "evil.example" }))).toMatchObject({ body: "Forbidden Setup host.", status: 403 })
    expect(await send(running.port, "GET", "status", auth(running, { host: "evil.example", origin: "http://evil.example" }))).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "session", { host: "evil.example", "sec-fetch-site": "same-origin" })).toMatchObject({ status: 403 })
  })

  it("rejects a network IP and allowedHosts: true, because the endpoints write files", async () => {
    const network = await start(true)
    expect(await send(network.port, "GET", "status", auth(network, { host: "192.168.1.20:5173" }))).toMatchObject({ body: "Forbidden Setup host.", status: 403 })
    expect(await send(network.port, "GET", "status", auth(network, { host: "evil.example" }))).toMatchObject({ body: "Forbidden Setup host.", status: 403 })
  })

  it("accepts a remote host only when allowedHosts names it, and still needs the token", async () => {
    const running = await start(["dev.example.com"])
    // HTTP browsers omit Fetch Metadata and Origin on a same-origin GET. A local tunnel preserves this flow.
    const session = await send(running.port, "GET", "session", { host: "dev.example.com", "x-vitehub-setup": "session" })
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body)).toMatchObject({ serverId: running.serverId, token: running.token })
    expect(await send(running.port, "GET", "status", { host: "dev.example.com" })).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "status", auth(running, { host: "dev.example.com", origin: "http://dev.example.com" }))).toMatchObject({ status: 200 })
  })

  const networkAddress = Object.values(networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)?.address
  it.skipIf(!networkAddress)("does not give a network peer the token even with forged browser and proxy headers", async () => {
    const running = await start(["dev.example.com"], "0.0.0.0")
    for (const host of [`localhost:${running.port}`, "dev.example.com"]) {
      const response = await send(running.port, "GET", "session", {
        host,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "127.0.0.1",
        "x-vitehub-setup": "session",
      }, undefined, networkAddress)
      expect(response.status).toBe(403)
      expect(response.body).not.toContain(running.token)
    }
  })

  it("needs the token on every route except the session", async () => {
    const running = await start()
    for (const [method, route] of [["GET", "catalog"], ["GET", "status"], ["POST", "plan"], ["POST", "apply"], ["GET", "events"]] as const) {
      expect(await send(running.port, method, route, {}, method === "POST" ? {} : undefined)).toMatchObject({ body: "Forbidden Setup request.", status: 403 })
      expect(await send(running.port, method, route, { "x-vitehub-dev-token": "0".repeat(64) }, method === "POST" ? {} : undefined)).toMatchObject({ status: 403 })
    }
    // A cross-site page gets no token, and the token file is the same one the CLI reads.
    expect(await send(running.port, "GET", "session", { "sec-fetch-site": "cross-site", "x-vitehub-setup": "session" })).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "session", { origin: "http://evil.example", "x-vitehub-setup": "session" })).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "session", { origin: `http://localhost:${running.port + 1}`, "x-vitehub-setup": "session" })).toMatchObject({ status: 403 })
    expect(await send(running.port, "GET", "session")).toMatchObject({ status: 403 })
    expect(await readViteHubDevToken(running.root, { namespace: setupDevTokenNamespace, serverId: running.serverId })).toBe(running.token)
  })

  it("bootstraps an IPv6 loopback peer and an IPv4-mapped loopback peer", async () => {
    const running = await start([], "::")
    const session = await send(running.port, "GET", "session", { host: `[::1]:${running.port}`, "x-vitehub-setup": "session" }, undefined, "::1")
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body)).toMatchObject({ serverId: running.serverId, token: running.token })
  })

  it("plans, applies a plan once, and streams the install output", async () => {
    const running = await start()
    const catalog = JSON.parse((await send(running.port, "GET", "catalog", auth(running))).body) as { features: { id: string }[] }
    expect(catalog.features.map(feature => feature.id)).toContain("kv")

    const planned = await send(running.port, "POST", "plan", auth(running), { action: "add", features: ["workspace"] })
    expect(planned.status).toBe(200)
    const plan = JSON.parse(planned.body) as { changes: { path: string }[], command: string, planId: string, restart: boolean, schemaVersion: 1, status: string }
    expect(plan).toMatchObject({ command: "vitehub add workspace --yes", restart: true, schemaVersion: 1, status: "planned" })
    expect(plan.changes.map(change => change.path)).toEqual(["vite.config.ts"])

    const events: string[] = []
    const stream = httpRequest({ headers: { host: `localhost:${running.port}`, ...auth(running) }, host: "127.0.0.1", path: `${setupDevRoute}/events`, port: running.port })
    const opened = new Promise<void>((done) => {
      stream.on("response", (res) => {
        res.setEncoding("utf8").on("data", (chunk: string) => {
          events.push(chunk)
          done()
        })
      })
    })
    stream.end()
    await opened

    const applied = await send(running.port, "POST", "apply", auth(running), { planId: plan.planId })
    expect(applied.status).toBe(200)
    expect(JSON.parse(applied.body)).toMatchObject({ restart: true, status: "applied" })
    expect(running.calls).toEqual([{ args: ["add", "@vite-hub/workspace"], command: "pnpm", cwd: running.root }])
    expect(await readFile(join(running.root, "vite.config.ts"), "utf8")).toContain("workspace: true")
    await new Promise(done => setTimeout(done, 50))
    const text = events.join("")
    expect(text).toContain(`event: hello\ndata: {"serverId":"${running.serverId}"}`)
    expect(text).toContain("event: log\ndata: {\"stream\":\"stdout\",\"text\":\"fake install\\n\"}")
    expect(text).toContain("event: applied")
    stream.destroy()

    const replayed = await send(running.port, "POST", "apply", auth(running), { planId: plan.planId })
    expect(replayed.status).toBe(404)
    expect(JSON.parse(replayed.body)).toMatchObject({ error: { code: "SETUP_PLAN_UNKNOWN" } })
  })

  it("answers a stale plan with the exit-4 document and writes nothing", async () => {
    const running = await start()
    const plan = JSON.parse((await send(running.port, "POST", "plan", auth(running), { action: "add", features: ["kv"] })).body) as { planId: string }
    const edited = "export default {}\n"
    await writeFile(join(running.root, "vite.config.ts"), edited)
    const stale = await send(running.port, "POST", "apply", auth(running), { planId: plan.planId })
    expect(stale.status).toBe(409)
    expect(JSON.parse(stale.body)).toMatchObject({ error: { code: "SETUP_STALE_PLAN" }, schemaVersion: 1 })
    expect(await readFile(join(running.root, "vite.config.ts"), "utf8")).toBe(edited)
  })

  it("never takes a path or a command from the request", async () => {
    const running = await start()
    for (const body of [
      { action: "add", features: ["kv"], root: "/tmp" },
      { action: "add", features: ["kv"], command: "touch /tmp/pwned" },
      { action: "add", features: ["queue"], name: "../../outside" },
      { action: "add", features: ["--yes"] },
    ]) {
      const response = await send(running.port, "POST", "plan", auth(running), body)
      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: "CLI_R0003" } })
    }
    const other = await mkdtemp(join(tmpdir(), "vitehub-setup-other-"))
    cleanups.push(async () => await rm(other, { force: true, recursive: true }))
    // The server ignores a root in the query: it reads its own project.
    const status = JSON.parse((await send(running.port, "GET", `status?root=${encodeURIComponent(other)}`, auth(running))).body) as { root: string }
    expect(status.root).toBe(running.root)
    expect(running.calls).toEqual([])
  })

  it("rejects a POST that is not JSON, and an unknown method", async () => {
    const running = await start()
    expect(await send(running.port, "POST", "plan", auth(running, { "content-type": "text/plain" }))).toMatchObject({ status: 415 })
    expect(await send(running.port, "DELETE", "plan", auth(running))).toMatchObject({ status: 405 })
  })

  it("removes the token file when the dev server closes", async () => {
    const running = await start()
    await running.close()
    cleanups.splice(cleanups.indexOf(running.close), 1)
    expect(await readViteHubDevToken(running.root, { namespace: setupDevTokenNamespace, serverId: running.serverId })).toBeUndefined()
  })
})

describe("isSetupDevRequestAllowed", () => {
  const server = { config: { server: { allowedHosts: ["dev.example.com", ".example.org"] } } }
  it.each([
    ["localhost:5173", undefined, true],
    ["127.0.0.1:5173", "http://127.0.0.1:5173", true],
    ["[::1]:5173", "http://[::1]:5173", true],
    ["app.localhost", undefined, true],
    ["dev.example.com", "http://dev.example.com", true],
    ["evil.example", undefined, false],
    ["localhost:5173", "http://evil.example", false],
    ["10.0.0.5:5173", undefined, false],
    // A wildcard entry does not name one host.
    ["a.example.org", undefined, false],
    [undefined, undefined, false],
  ])("Host %s, Origin %s: %s", (host, origin, allowed) => {
    expect(isSetupDevRequestAllowed(server, { headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}) } })).toBe(allowed)
  })
})
