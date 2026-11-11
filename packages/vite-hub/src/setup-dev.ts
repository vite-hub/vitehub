import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { dirname, join, resolve } from "node:path"
import process from "node:process"

import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { SetupCommandRunner, SetupSession, SetupSessionResult } from "@vite-hub/cli/setup"
import type { ViteHubDevEndpointServer } from "@vite-hub/internal/dev-endpoint"
import type { Plugin, ViteDevServer } from "vite"

/** Base of the dev Setup endpoints. They exist only on the Vite dev server, never in Nitro or in build output. */
export const setupDevRoute = "/__vitehub/setup"

/** Token namespace of the dev Setup endpoints. The token file lets a local CLI call them too. */
export const setupDevTokenNamespace = "vitehub-setup"

const label = "Setup"
const maxBodyBytes = 64 * 1024

export interface SetupDevPluginOptions {
  /** Runs the package manager. Tests pass a fake runner. */
  run?: SetupCommandRunner
}

/** Runs `command` with an argument array and no shell, and streams its output. */
export const runSetupCommand: SetupCommandRunner = async (command, args, options) => await new Promise((done) => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.setEncoding("utf8").on("data", (text: string) => options.onOutput(text, "stdout"))
  child.stderr.setEncoding("utf8").on("data", (text: string) => options.onOutput(text, "stderr"))
  child.once("error", (error) => {
    options.onOutput(`${error.message}\n`, "stderr")
    done({ exitCode: 1 })
  })
  child.once("close", (exitCode, signal) => done({ exitCode, signal }))
})

/** The closest folder from `root` up that has a package.json. Nuxt runs Vite in its source folder. */
function projectRoot(root: string): string {
  for (let folder = resolve(root); ; folder = dirname(folder)) {
    if (existsSync(join(folder, "package.json"))) return folder
    if (dirname(folder) === folder) return resolve(root)
  }
}

function hostname(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1)
  const colon = trimmed.indexOf(":")
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

function isLoopback(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(name)
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/u, "")
  return address === "::1" || (address !== undefined && /^127(?:\.\d{1,3}){3}$/u.test(address))
}

/**
 * Loopback `Host` and `Origin`, and host names that `server.allowedHosts` lists one by one. An IP literal of the network,
 * `allowedHosts: true`, or `server.https` does not open the Setup endpoints, because they write files. The dev endpoint
 * guard then accepts only the origin of this server.
 */
export function isSetupDevRequestAllowed(server: Pick<ViteHubDevEndpointServer, "config">, req: Pick<IncomingMessage, "headers">): boolean {
  const allowed = server.config.server.allowedHosts
  const explicit = Array.isArray(allowed) ? allowed.map(host => host.toLowerCase()).filter(host => !host.startsWith(".")) : []
  const accepts = (name: string) => isLoopback(name) || explicit.includes(name)
  const host = req.headers.host
  if (!host || !accepts(hostname(host))) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    // The URL parser keeps the brackets of an IPv6 host, as in `[::1]`.
    return accepts(new URL(origin).hostname.toLowerCase())
  }
  catch {
    return false
  }
}

function forbidden(): Response {
  return new Response(`Forbidden ${label} host.`, { status: 403 })
}

/** Ask the Console runtime for this caller's current grant, across the Vite/Nitro process boundary. */
async function authorizeSetupApply(server: ViteDevServer, req: IncomingMessage): Promise<Response | undefined> {
  const address = req.socket.localAddress?.replace(/^::ffff:/u, "")
  const port = req.socket.localPort
  if (!address || !port) return new Response("The Console access check is unavailable.", { status: 503 })
  const headers: Record<string, string | string[]> = {}
  const transportHeaders = new Set(["connection", "content-length", "transfer-encoding", "content-encoding", "expect", "upgrade", "keep-alive", "te", "trailer"])
  // Setup takes only same-origin calls, so the browser headers pass the same-origin check of the Console RPC as they are.
  // A caller without Origin or Fetch Metadata, such as a local tool with the dev token, gets the RPC header instead.
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !transportHeaders.has(name)) headers[name] = value
  }
  headers["content-type"] = "application/json"
  headers["x-vitehub-console"] = "1"
  try {
    // The TCP destination comes only from our accepted socket, never from Host or forwarding headers.
    // Re-enter the app listener so this also reaches Nuxt's separate Nitro worker and mounted apps.
    const request = "encrypted" in req.socket && req.socket.encrypted ? httpsRequest : httpRequest
    const outcome = await callOperationRpc("sections.list", {}, async (body) => {
      const response = await new Promise<{ status: number, body: string }>((done, fail) => {
        const call = request({
          agent: false,
          headers,
          hostname: address,
          method: "POST",
          path: `${viteHubPageToolsBase(server.config).base}${operationRpcPath}`,
          port,
          // This is our own TLS listener, which may use a development certificate.
          rejectUnauthorized: false,
          signal: AbortSignal.timeout(5_000),
        }, (res) => {
          let body = ""
          let size = 0
          res.setEncoding("utf8").on("data", (chunk: string) => {
            size += Buffer.byteLength(chunk)
            if (size > maxBodyBytes) return res.destroy(new RangeError("Console access response is too large."))
            body += chunk
          }).on("end", () => done({ body, status: res.statusCode ?? 500 })).on("error", fail)
        })
        call.once("error", fail)
        call.end(body)
      })
      const document: unknown = JSON.parse(response.body)
      return { body: document, status: response.status }
    })
    const value = outcome.ok ? outcome.value : undefined
    const sections: unknown = value && typeof value === "object" ? Reflect.get(value, "sections") : undefined
    const readOnly: unknown = value && typeof value === "object" ? Reflect.get(value, "readOnly") : undefined
    if (outcome.answer.status === 200 && Array.isArray(sections) && sections.includes("setup") && (readOnly === undefined || (Array.isArray(readOnly) && !readOnly.includes("setup")))) return
    return new Response("This Console access does not allow Setup writes.", { status: 403 })
  }
  catch {
    return new Response("The Console access check is unavailable.", { status: 503 })
  }
}

/** The HTTP status of a setup document: the exit code says why it failed. */
const exitStatus: ReadonlyMap<number, number> = new Map([[0, 200], [1, 500], [2, 422], [3, 409], [4, 409]])

export function setupHttpStatus(result: SetupSessionResult): number {
  const error = result.body.error
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined
  if (code === "CLI_R0003") return 400
  if (code === "SETUP_PLAN_UNKNOWN") return 404
  return exitStatus.get(result.exitCode) ?? 500
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("cache-control", "no-store")
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    // Internal invariant: the guarded endpoint catches this size sentinel and returns a 400 CLI_R0003 document.
    if (size > maxBodyBytes) throw new RangeError("The request body is too large.")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
}

interface SetupDevState {
  events: Set<ServerResponse>
  serverId: string
  session: SetupSession
  token: string
}

function send(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(state: SetupDevState, event: string, data: unknown): void {
  for (const res of state.events) send(res, event, data)
}

function openEvents(state: SetupDevState, req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200
  res.setHeader("cache-control", "no-store")
  res.setHeader("content-type", "text/event-stream; charset=utf-8")
  res.setHeader("x-accel-buffering", "no")
  res.flushHeaders()
  send(res, "hello", { serverId: state.serverId })
  state.events.add(res)
  // A comment line keeps proxies from closing an idle stream.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000)
  heartbeat.unref()
  const close = () => {
    clearInterval(heartbeat)
    state.events.delete(res)
  }
  req.once("close", close)
  res.once("close", close)
}

function register(server: ViteDevServer, state: SetupDevState): void {
  const authorize = (req: IncomingMessage) => isSetupDevRequestAllowed(server, req) ? undefined : forbidden()
  const guarded = (route: string, method: "GET" | "POST", handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) => registerViteHubDevEndpoint(server, {
    authorize: async req => authorize(req) ?? (route === "apply" ? await authorizeSetupApply(server, req) : undefined),
    handle: (req, res) => {
      void (async () => await handle(req, res))().catch((error: unknown) => {
        if (res.headersSent) return res.destroy()
        writeJson(res, error instanceof SyntaxError || error instanceof RangeError ? 400 : 500, { error: { code: "CLI_R0003", message: error instanceof Error ? error.message : String(error) }, schemaVersion: 1 })
      })
    },
    header: viteHubDevTokenHeader,
    headerValue: state.token,
    label,
    methods: [method],
    route: `${setupDevRoute}/${route}`,
  })
  const respond = (res: ServerResponse, result: SetupSessionResult) => writeJson(res, setupHttpStatus(result), result.body)

  // Only a local TCP peer can bootstrap the credential; Host and Fetch Metadata can be forged by network clients.
  // The shared guard accepts only the origin of this server, and Fetch Metadata, when present, adds another check.
  // HTTP hostnames can omit that metadata.
  registerViteHubDevEndpoint(server, {
    authorize: (req) => {
      const rejection = authorize(req)
      if (rejection) return rejection
      if (!isLoopbackPeer(req)) return new Response("Open Setup through a local connection or an SSH port forward.", { status: 403 })
      const site = req.headers["sec-fetch-site"]
      return site === undefined || site === "same-origin" ? undefined : new Response(`Forbidden ${label} request.`, { status: 403 })
    },
    handle: (_req, res) => writeJson(res, 200, { route: setupDevRoute, schemaVersion: 1, serverId: state.serverId, token: state.token }),
    header: "x-vitehub-setup",
    headerValue: "session",
    label,
    methods: ["GET"],
    route: `${setupDevRoute}/session`,
  })
  guarded("catalog", "GET", (_req, res) => respond(res, state.session.catalog()))
  guarded("status", "GET", async (_req, res) => respond(res, await state.session.status()))
  guarded("plan", "POST", async (req, res) => respond(res, await state.session.plan(await readJsonBody(req))))
  guarded("apply", "POST", async (req, res) => {
    const body = await readJsonBody(req)
    const planId = body && typeof body === "object" ? Reflect.get(body, "planId") : undefined
    broadcast(state, "apply", { planId })
    const result = await state.session.apply(planId, (text, stream) => broadcast(state, "log", { stream, text }))
    broadcast(state, "applied", { exitCode: result.exitCode, restart: result.body.restart === true })
    respond(res, result)
  })
  guarded("events", "GET", (req, res) => openEvents(state, req, res))
}

/**
 * The dev Setup endpoints below `/__vitehub/setup`, on the Vite dev server only (`apply: "serve"`). They do what
 * `vitehub status`, `catalog`, `add`, and `remove` do, with the same engine and documents:
 *
 * - `GET session`: the server id and the token, for a same-origin page on a local connection (`x-vitehub-setup: session`).
 * - `GET catalog`, `GET status`: the `--json` documents.
 * - `POST plan`: `{ action, features, ... }` gives the `--dry-run --json` plan with a `planId`.
 * - `POST apply`: `{ planId }` applies that plan once, when no file that it read has changed.
 * - `GET events`: Server-Sent Events: `hello` with the server id, then install `log` lines and `applied`.
 *
 * Every route except `session` needs the `x-vitehub-dev-token` header. Only pages of this dev server, such as its DevTools,
 * and local tools that read the token file may call them: there is no CORS. The server owns the project root: a request
 * never names a path or a command. Remote servers need local port forwarding to bootstrap a session.
 */
export function setupDevPlugin(options: SetupDevPluginOptions = {}): Plugin {
  return {
    apply: "serve",
    name: "vite-hub/setup-dev",
    async configureServer(server) {
      const root = projectRoot(server.config.root)
      const serverId = randomUUID()
      const { token } = await createViteHubDevToken(root, setupDevTokenNamespace, serverId)
      const { createSetupSession } = await import("@vite-hub/cli/setup")
      const state: SetupDevState = {
        events: new Set(),
        serverId,
        session: createSetupSession({ env: process.env, root, run: options.run ?? runSetupCommand }),
        token,
      }
      register(server, state)
      const close = server.close.bind(server)
      server.close = async () => {
        for (const res of state.events) res.end()
        state.events.clear()
        await removeViteHubDevToken(root, { namespace: setupDevTokenNamespace, serverId })
        await close()
      }
    },
  }
}
