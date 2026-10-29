import type { IncomingMessage } from "node:http"
import type { Plugin } from "vite"

import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

const consoleRpcCallPath = "/_vitehub/rpc/__call"

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
  "status.get": "status",
  "usage.get": "usage",
}

// Map one Console call to the synthetic HTTP route that serves its fixture data.
export async function callConsoleFixture(origin: string, payload: { input?: Record<string, unknown>; operation: string }, cookie?: string): Promise<ConsoleRpcResult> {
  const input = payload.input ?? {}
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
  const writes: Record<string, string> = { "blob.del": "blob", "blob.put": "blob", "kv.del": "kv", "kv.set": "kv", "rate-limit.peek": "rate-limit", "rate-limit.reset": "rate-limit" }
  if (writes[payload.operation]) {
    route = writes[payload.operation]
    method = "POST"
    body = { ...input, action: payload.operation.split(".")[1] }
  }
  if (!route) return { code: "CONSOLE_REQUEST_INVALID", message: `The playground has no fixture for ${payload.operation}.`, ok: false, status: 404 }
  const url = new URL(`/api/_vitehub/console/${route}`, origin)
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
  if (!response.ok) return { code: "CONSOLE_REQUEST_FAILED", message: await response.text(), ok: false, status: response.status }
  return { ok: true, value: await response.json() }
}

// Serve the Console's stateless RPC endpoint from this playground's synthetic HTTP fixtures.
export function consoleMockRPC(): Plugin {
  return {
    name: "vitehub-console-playground-rpc",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "POST" || request.url?.split("?")[0] !== consoleRpcCallPath) {
          next()
          return
        }
        void (async () => {
          const origin = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
          if (!origin) throw new Error("Playground server is not listening")
          const result = await callConsoleFixture(origin, JSON.parse(await readBody(request)), request.headers.cookie)
          response.statusCode = result.ok ? 200 : result.status
          response.setHeader("cache-control", "no-store")
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(result))
        })().catch(next)
      })
    },
  }
}
