import type { IncomingMessage } from "node:http"
import type { Plugin } from "vite"

import { operationRpcPath, operationRpcRefusal, readOperationRpcCall } from "../../packages/internal/src/operation-rpc.ts"
import { consoleDiagnosticBody, consoleStatusDiagnosticCode } from "../../packages/vite-hub/src/console/runtime/diagnostics.ts"
import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"
import { consolePublicURL } from "../../packages/vite-hub/src/console/runtime/server/request.ts"
import { authConsoleActionOperations, authConsoleImpersonationOperations, authConsoleReadOperations } from "../../packages/vite-hub/src/console/runtime/auth-operations.ts"
import { authFixture } from "./auth-fixture.ts"
import { cacheFixture } from "./cache-fixture.ts"
import { channelsFixture } from "./channels-fixture.ts"
import { callCommentsFixture } from "./comments.ts"
import { mcpClientFixture } from "./mcp-client-fixture.ts"
import { servedSkillsFixture } from "./served-skills-fixture.ts"
import { siteFixture } from "./site-fixture.ts"

const authReads = new Map<string, string>(Object.entries(authConsoleReadOperations).map(([read, operation]) => [operation, read]))
const authActions = new Map<string, string>(Object.entries(authConsoleActionOperations).map(([action, operation]) => [operation, action]))

/** Answer an `auth.*` operation from the synthetic Auth fixture, which keeps the command shape of the Auth Console. */
function authOperationFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  const events = process.env.VITEHUB_PLAYGROUND_AUTH_EVENTS !== "off"
  const read = authReads.get(operation)
  if (read) {
    const { cursor, group, id, ...query } = input
    return { ok: true, value: authFixture({ activity: { cursor, group, limit: query.limit, userId: query.userId }, id, operation: read, query }, events) }
  }
  const action = authActions.get(operation)
  if (action) return { ok: true, value: authFixture({ ...input, action }, events) }
  // Impersonation returns a one-time link in a real app. The playground changes its fixture and links to its home page.
  const impersonation = operation === authConsoleImpersonationOperations.start ? "impersonate" : operation === authConsoleImpersonationOperations.stop ? "stopImpersonating" : undefined
  if (!impersonation) return undefined
  authFixture({ ...input, action: impersonation }, events)
  return { ok: true, value: { url: "/", expiresAt: new Date(Date.now() + 60_000).toISOString() } }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

// The synthetic HTTP route that serves the fixture data of each operation.
const fixtureRoutes: Record<string, string> = {
  "agents.list": "agents",
  "blob.list": "blob",
  "databases.browse": "database",
  "definitions.list": "definitions",
  "env.get": "env",
  "invocations.capabilities": "invocation-capabilities",
  "invocations.list": "invocations",
  "kv.list": "kv",
  "logs.list": "logs",
  "search.query": "search",
  "sections.list": "sections",
  "skills.inspect": "skills",
  "status.get": "status",
  "usage.get": "usage",
}

// Map one Console call to the synthetic HTTP route that serves its fixture data.
export async function callConsoleFixture(origin: string, payload: { input?: Record<string, unknown>; operation: string }, cookie?: string): Promise<ConsoleRpcResult> {
  // The MCP client keeps its connections in this process, so its fixture answers here, not over HTTP.
  if (payload.operation.startsWith("mcp-client.")) return mcpClientFixture(origin, payload)
  const input = payload.input ?? {}
  const auth = authOperationFixture(payload.operation, input)
  if (auth) return auth
  const comment = callCommentsFixture(payload.operation, input)
  if (comment) return comment
  const channel = channelsFixture(payload.operation, input)
  if (channel) return channel
  const site = siteFixture(origin, payload.operation, input)
  if (site) return site
  const cache = await cacheFixture(payload.operation, input)
  if (cache) return cache
  const servedSkills = servedSkillsFixture(payload.operation, input)
  if (servedSkills) return servedSkills
  let route = fixtureRoutes[payload.operation]
  let method = "GET"
  let body: unknown
  const query = { ...input }
  if (payload.operation === "invocations.get") route = `invocations/${encodeURIComponent(String(input.id ?? ""))}`
  if (payload.operation === "invocations.workspace") route = `invocations/${encodeURIComponent(String(input.id ?? ""))}/workspace`
  if (payload.operation === "invocations.cancel" || payload.operation === "invocations.delete") {
    route = `invocations/${encodeURIComponent(String(input.id ?? ""))}`
    method = "POST"
    body = { action: payload.operation.split(".")[1] }
  }
  if (payload.operation === "agents.invoke") {
    const { agent, ...rest } = input
    route = `agents/${encodeURIComponent(String(agent ?? ""))}/invocations`
    method = "POST"
    body = rest
  }
  if (payload.operation === "kv.get") {
    route = "kv"
    method = "POST"
    body = input
  }
  // Writes and counters share one fixture route per section, told apart by `action`.
  const writes: Record<string, string> = { "blob.delete": "blob", "blob.put": "blob", "kv.delete": "kv", "kv.set": "kv", "rate-limit.peek": "rate-limit", "rate-limit.reset": "rate-limit" }
  if (writes[payload.operation]) {
    route = writes[payload.operation]
    method = "POST"
    body = { ...input, action: payload.operation.split(".")[1] }
  }
  if (!route) return { code: "CONSOLE_REQUEST_INVALID", message: `The playground has no fixture for ${payload.operation}.`, ok: false, status: 404 }
  const url = new URL(`/_vitehub/api/${route}`, origin)
  if (method === "GET") {
    for (const [key, value] of Object.entries(query)) {
      if (key === "id" && payload.operation !== "invocations.list") continue
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry))
    }
  }
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    // The cookie carries the playground's failure switch from `mock-api.ts`.
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    method,
  })
  // Answer as the server RPC does for a failure without its own code, so 401 asks to sign in and 403 shows a lock.
  if (!response.ok) return { ...consoleDiagnosticBody(consoleStatusDiagnosticCode(response.status), await response.text()), ok: false, status: response.status }
  return { ok: true, value: await response.json() }
}

// Serve the Console's stateless RPC endpoint from this playground's synthetic HTTP fixtures.
export function consoleMockRPC(): Plugin {
  return {
    name: "vitehub-console-playground-rpc",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "POST" || request.url?.split("?")[0] !== operationRpcPath) {
          next()
          return
        }
        void (async () => {
          const call = readOperationRpcCall(JSON.parse(await readBody(request)))
          if (!call) {
            response.statusCode = 400
            response.setHeader("content-type", "application/json")
            response.end(JSON.stringify(operationRpcRefusal({ code: "CONSOLE_REQUEST_INVALID", message: "Invalid Console request.", status: 400 })))
            return
          }
          const payload = { operation: call.m, input: call.a[0] instanceof Object && !Array.isArray(call.a[0]) ? Object.fromEntries(Object.entries(call.a[0])) : {} }
          // MCP links go back to the browser, while HTTP fixtures stay on the local server.
          const origin = payload.operation.startsWith("mcp-client.")
            ? consolePublicURL(new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`), { headers: Object.entries(request.headers).flatMap(([name, value]) => value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]) })).origin
            : server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
          if (!origin) throw new Error("Playground server is not listening")
          const result = await callConsoleFixture(origin, payload, request.headers.cookie)
          response.statusCode = result.ok ? 200 : result.status
          response.setHeader("cache-control", "no-store")
          response.setHeader("content-type", "application/json")
          // Answer with one birpc reply, as the server RPC does.
          if (result.ok) {
            response.end(JSON.stringify({ t: "s", i: call.i, r: result.value }))
            return
          }
          const { ok: _ok, ...failure } = result
          response.end(JSON.stringify({ t: "s", i: call.i, e: failure }))
        })().catch(next)
      })
    },
  }
}
