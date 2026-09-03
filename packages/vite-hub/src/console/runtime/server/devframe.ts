import { defineDevframe, defineRpcFunction } from "devframe"
import { createDevframeH3Handler } from "devframe/adapters/h3"

import { consoleRpcMethods } from "../rpc.ts"
import consoleAgentsHandler from "./agents.get.ts"
import consoleBlobHandler from "./blob.get.ts"
import consoleDatabaseHandler from "./database.get.ts"
import consoleDefinitionsHandler from "./definitions.get.ts"
import consoleInvocationCapabilitiesHandler from "./invocation-capabilities.get.ts"
import consoleInvocationHandler from "./invocation.get.ts"
import consoleInvocationsHandler from "./invocations.get.ts"
import consoleKVHandler from "./kv.get.ts"
import { consoleSearchCollectionHandler } from "./search.get.ts"
import consoleSectionsHandler from "./sections.get.ts"
import consoleUsageHandler from "./usage.get.ts"

import type { DevframeDefinition } from "devframe"
import type { DevframeH3Handler } from "devframe/adapters/h3"
import type { ConsoleRpcFunctions, ConsoleRpcInput, ConsoleRpcResult } from "../rpc.ts"
import type { ConsoleRequestEvent } from "./request.ts"

export const consoleDevframeBase = "/_vitehub/rpc/"

function requestEvent(operation: string, input: ConsoleRpcInput): ConsoleRequestEvent {
  const id = input.id ? `/${encodeURIComponent(input.id)}` : ""
  const url = new URL(`/api/_vitehub/console/${operation}${id}`, "http://vitehub.local")
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry))
    else url.searchParams.set(key, value)
  }
  return {
    context: input.id ? { params: { id: input.id } } : undefined,
    method: input.method ?? "GET",
    req: {
      json: async () => input.body,
      method: input.method ?? "GET",
      url,
    },
  }
}

function errorResult(error: unknown): ConsoleRpcResult {
  const value = Object(error)
  const rawStatus = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const statusMessage = Reflect.get(value, "statusMessage")
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Handler failures cross the RPC boundary as unknown values.
  const message = typeof statusMessage === "string" ? statusMessage : error instanceof Error ? error.message : "Console request failed."
  return { message, ok: false, status }
}

async function result(resolve: () => unknown | Promise<unknown>): Promise<ConsoleRpcResult> {
  try {
    return { ok: true, value: await resolve() }
  } catch (error) {
    return errorResult(error)
  }
}

const operations = {
  [consoleRpcMethods.agents]: (input: ConsoleRpcInput) => consoleAgentsHandler(requestEvent("agents", input)),
  [consoleRpcMethods.blob]: (input: ConsoleRpcInput) => consoleBlobHandler(requestEvent("blob", input)),
  [consoleRpcMethods.database]: (input: ConsoleRpcInput) => consoleDatabaseHandler(requestEvent("database", input)),
  [consoleRpcMethods.definitions]: (input: ConsoleRpcInput) => consoleDefinitionsHandler(requestEvent("definitions", input)),
  [consoleRpcMethods.invocation]: (input: ConsoleRpcInput) => consoleInvocationHandler(requestEvent("invocations", input)),
  [consoleRpcMethods.invocationCapabilities]: (input: ConsoleRpcInput) => consoleInvocationCapabilitiesHandler(requestEvent("invocation-capabilities", input)),
  [consoleRpcMethods.invocations]: (input: ConsoleRpcInput) => consoleInvocationsHandler(requestEvent("invocations", input)),
  [consoleRpcMethods.kv]: (input: ConsoleRpcInput) => consoleKVHandler(requestEvent("kv", input)),
  async [consoleRpcMethods.search](input: ConsoleRpcInput) {
    const event = requestEvent("search", input)
    const response = await consoleSearchCollectionHandler.fetch(new Request(event.req!.url!, { method: event.method }))
    if (!response.ok) throw Object.assign(new Error(await response.text()), { statusCode: response.status })
    return await response.json()
  },
  [consoleRpcMethods.sections]: (input: ConsoleRpcInput) => consoleSectionsHandler(requestEvent("sections", input)),
  [consoleRpcMethods.usage]: (input: ConsoleRpcInput) => consoleUsageHandler(requestEvent("usage", input)),
} satisfies Record<keyof ConsoleRpcFunctions, (input: ConsoleRpcInput) => unknown | Promise<unknown>>

export const consoleDevframe: DevframeDefinition = defineDevframe({
  description: "Live inspection transport for the ViteHub Console.",
  homepage: "https://vitehub.dev",
  id: "vitehub-console",
  importMetaUrl: import.meta.url,
  name: "ViteHub Console",
  packageName: "vite-hub",
  version: "0.0.1",
  setup(context) {
    for (const [name, handler] of Object.entries(operations)) {
      context.rpc.register(
        defineRpcFunction({
          handler: (input: ConsoleRpcInput = {}) => result(() => handler(input)),
          jsonSerializable: true,
          name,
          type: "query",
        }),
      )
    }
  },
})

export function createConsoleDevframeHandler(): DevframeH3Handler {
  return createDevframeH3Handler(consoleDevframe, {
    allowedOrigins: false,
    auth: false,
    base: consoleDevframeBase,
    distDir: false,
    mcp: false,
    responseHeaders: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
    ws: false,
  })
}

const consoleDevframeHandler: DevframeH3Handler = createConsoleDevframeHandler()

export default consoleDevframeHandler
