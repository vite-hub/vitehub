import { defineDevframe, defineRpcFunction } from "devframe"
import { initDevframe } from "devframe/initiate"
import { H3, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import { consoleRpcMethods } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

import type { ConsoleRpcInput, ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"
import type { Plugin } from "vite"

// Exercise the real Console transport against this playground's synthetic HTTP fixtures.
export function consoleMockRPC(): Plugin {
  return {
    name: "vitehub-console-playground-rpc",
    configureServer(server) {
      const definition = defineDevframe({
        name: "Console playground",
        packageName: "playground-console",
        version: "0.0.1",
        setup(context) {
          for (const [operation, name] of Object.entries(consoleRpcMethods)) {
            context.rpc.register(defineRpcFunction({
              name,
              type: "query",
              jsonSerializable: true,
              async handler(input: ConsoleRpcInput = {}): Promise<ConsoleRpcResult> {
                const address = server.httpServer?.address()
                if (!address || typeof address === "string") throw new Error("Playground server is not listening")
                const path = operation === "invocation" ? `invocations/${encodeURIComponent(input.id ?? "")}`
                  : operation === "agentInvocations" ? `agents/${input.agent ?? ""}/invocations`
                    : operation === "invocationCapabilities" ? "invocation-capabilities" : operation
                const url = new URL(`/api/_vitehub/console/${path}`, `http://127.0.0.1:${address.port}`)
                for (const [key, value] of Object.entries(input.query ?? {})) {
                  for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, entry)
                }
                const response = await fetch(url, {
                  method: input.method ?? "GET",
                  ...(input.body === undefined ? {} : { body: JSON.stringify(input.body), headers: { "content-type": "application/json" } }),
                })
                if (!response.ok) return { ok: false, status: response.status, message: await response.text() }
                return { ok: true, value: await response.json() }
              },
            }))
          }
        },
      })
      const instance = initDevframe(definition, {
        allowedOrigins: false,
        auth: false,
        base: "/_vitehub/rpc/",
        distDir: false,
        mcp: false,
        ws: false,
      })
      const handler = toNodeHandler(new H3().all("/**", fromWebHandler(instance.handler)))
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/_vitehub/rpc/")) void handler(request, response)
        else next()
      })
      server.httpServer?.once("close", () => { void instance.close() })
    },
  }
}
