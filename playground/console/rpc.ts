import type { IncomingMessage } from "node:http"
import type { Plugin } from "vite"

import type { ConsoleRpcInput, ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

const consoleRpcCallPath = "/_vitehub/rpc/__call"

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

// Map one Console call to the synthetic HTTP route that serves its fixture data.
export async function callConsoleFixture(origin: string, payload: { input?: ConsoleRpcInput; method: string }): Promise<ConsoleRpcResult> {
  const input = payload.input ?? {}
  let operation = payload.method.replace("vitehub:console:", "")
  if (operation === "invocation") operation = `invocations/${encodeURIComponent(input.id ?? "")}`
  if (operation === "agent-invocations") operation = `agents/${encodeURIComponent(input.agent ?? "")}/invocations`
  const url = new URL(`/api/_vitehub/console/${operation}`, origin)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry)
  }
  const response = await fetch(url, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: { "content-type": "application/json" },
    method: input.method ?? "GET",
  })
  if (!response.ok) return { message: await response.text(), ok: false, status: response.status }
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
          const result = await callConsoleFixture(origin, JSON.parse(await readBody(request)))
          response.statusCode = result.ok ? 200 : result.status
          response.setHeader("cache-control", "no-store")
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(result))
        })().catch(next)
      })
    },
  }
}
