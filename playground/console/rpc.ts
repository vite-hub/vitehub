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
import { callCommentsFixture, openCommentsFixture } from "./comments.ts"
import { mcpClientFixture } from "./mcp-client-fixture.ts"
import { servedSkillsFixture } from "./served-skills-fixture.ts"
import { siteFixture } from "./site-fixture.ts"
import { webhooksFixture } from "./webhooks-fixture.ts"

const authReads = new Map<string, string>(Object.entries(authConsoleReadOperations).map(([read, operation]) => [operation, read]))
const authActions = new Map<string, string>(Object.entries(authConsoleActionOperations).map(([action, operation]) => [operation, action]))

function authOperationFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  const events = process.env.VITEHUB_PLAYGROUND_AUTH_EVENTS !== "off"
  const read = authReads.get(operation)
  if (read) {
    const { cursor, group, id, ...query } = input
    return { ok: true, value: authFixture({ activity: { cursor, group, limit: query.limit, userId: query.userId }, id, operation: read, query }, events) }
  }
  const action = authActions.get(operation)
  if (action) return { ok: true, value: authFixture({ ...input, action }, events) }
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

const fixtureRoutes: Record<string, string> = {
  "agents.list": "agents",
  "blob.list": "blob",
  "databases.browse": "database",
  "definitions.list": "definitions",
  "env.get": "env",
  "env.inspect": "env-inspect",
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

const projectFixture = {
  build: {
    commit: { author: "Maxi", branch: "main", message: "feat(content): add the ferry schedule to the travel guide", repository: "vite-hub/vitehub", sha: "4f9c2e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f" },
    framework: { name: "nuxt", version: "5.0.2" },
    host: { name: "cloudflare", preset: "cloudflare-module" },
    time: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  },
  name: "playground-console",
  operations: [],
  protocol: 1,
  sections: [],
  vitehub: "0.0.0-playground",
}

export async function callConsoleFixture(origin: string, payload: { input?: Record<string, unknown>; operation: string }, cookie?: string): Promise<ConsoleRpcResult> {
  if (payload.operation.startsWith("mcp-client.")) return mcpClientFixture(origin, payload)
  if (payload.operation === "project.get") return { ok: true, value: { ...projectFixture, comments: { open: openCommentsFixture() } } }
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
  const webhooks = webhooksFixture(payload.operation, input)
  if (webhooks) return webhooks
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
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    method,
  })
  if (!response.ok) return { ...consoleDiagnosticBody(consoleStatusDiagnosticCode(response.status), await response.text()), ok: false, status: response.status }
  return { ok: true, value: await response.json() }
}

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
          const origin = payload.operation.startsWith("mcp-client.")
            ? consolePublicURL(new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`), { headers: Object.entries(request.headers).flatMap(([name, value]) => value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]) })).origin
            : server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
          if (!origin) throw new Error("Playground server is not listening")
          const result = await callConsoleFixture(origin, payload, request.headers.cookie)
          response.statusCode = result.ok ? 200 : result.status
          response.setHeader("cache-control", "no-store")
          response.setHeader("content-type", "application/json")
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
