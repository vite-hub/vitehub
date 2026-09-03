import { defineDevframe } from "devframe"

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
import { setConsoleResponseHeaders } from "./request.ts"

import type { DevframeInstance } from "devframe/initiate"
import type { DevframeDefinition } from "devframe"
import type { ConsoleRequestEvent } from "./request.ts"

interface ConsoleRpcRequest {
  body?: unknown
  method: "GET" | "POST"
  path: string
  query: Record<string, string | string[]>
}

type ConsoleRpcResult =
  | { ok: true; value: unknown }
  | { message: string; ok: false; status: number }

interface NodeConsoleRequest extends AsyncIterable<Uint8Array> {
  aborted?: boolean
  headers: Record<string, string | string[] | undefined>
  method?: string
  once(name: "aborted", callback: () => void): void
  url?: string
}

const consoleApiMarker = "/api/_vitehub/console/"
export const consoleDevframeBase = "/_vitehub/rpc/"

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function requestURL(input: ConsoleRpcRequest): URL {
  const url = new URL(input.path, "http://vitehub.local")
  for (const [key, value] of Object.entries(input.query)) {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry))
    else url.searchParams.set(key, value)
  }
  return url
}

function requestEvent(input: ConsoleRpcRequest, url: URL): ConsoleRequestEvent {
  return {
    context: {
      params: url.pathname.startsWith(`${consoleApiMarker}invocations/`)
        ? { id: decodeURIComponent(url.pathname.slice(`${consoleApiMarker}invocations/`.length)) }
        : undefined,
    },
    method: input.method,
    req: {
      json: async () => input.body,
      method: input.method,
      url,
    },
  }
}

async function dispatchConsoleRequest(input: ConsoleRpcRequest): Promise<unknown> {
  const url = requestURL(input)
  const marker = url.pathname.indexOf(consoleApiMarker)
  if (marker === -1) throw requestError(404, "Console operation not found.")
  const operation = url.pathname.slice(marker + consoleApiMarker.length)
  const event = requestEvent(input, new URL(url.pathname.slice(marker) + url.search, url))

  if (operation === "sections") return consoleSectionsHandler(event)
  if (operation === "definitions") return consoleDefinitionsHandler(event)
  if (operation === "database") return await consoleDatabaseHandler(event)
  if (operation === "agents") return await consoleAgentsHandler(event)
  if (operation === "invocations") return await consoleInvocationsHandler(event)
  if (operation === "invocation-capabilities") return await consoleInvocationCapabilitiesHandler(event)
  if (operation.startsWith("invocations/")) return await consoleInvocationHandler(event)
  if (operation === "usage") return await consoleUsageHandler(event)
  if (operation === "blob") return await consoleBlobHandler(event)
  if (operation === "kv") return await consoleKVHandler(event)
  if (operation === "search") {
    const response = await consoleSearchCollectionHandler.fetch(
      new Request(url, { method: input.method }),
    )
    if (!response.ok) throw requestError(response.status, await response.text())
    return await response.json()
  }
  throw requestError(404, "Console operation not found.")
}

function errorResult(error: unknown): ConsoleRpcResult {
  const value = Object(error)
  const rawStatus = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  const status =
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const statusMessage = Reflect.get(value, "statusMessage")
  const message =
    typeof statusMessage === "string"
      ? statusMessage
      : error instanceof Error
        ? error.message
        : "Console request failed."
  return { message, ok: false, status }
}

export const consoleDevframe: DevframeDefinition = defineDevframe({
  description: "Live inspection transport for the ViteHub Console.",
  homepage: "https://vitehub.dev",
  id: "vitehub-console",
  importMetaUrl: import.meta.url,
  name: "ViteHub Console",
  packageName: "vite-hub",
  version: "0.0.1",
  setup(context) {
    context.rpc.register({
      handler: async (input: ConsoleRpcRequest): Promise<ConsoleRpcResult> => {
        try {
          return { ok: true, value: await dispatchConsoleRequest(input) }
        } catch (error) {
          return errorResult(error)
        }
      },
      jsonSerializable: true,
      name: "vitehub:console:request",
      type: "query",
    })
  },
})

function webRequest(event: ConsoleRequestEvent): Request {
  if (event.req instanceof Request) return event.req
  if (!event.node)
    throw new TypeError("[vitehub] Console Devframe received an unsupported non-Web request.")
  const request = event.node.req as NodeConsoleRequest
  const method = event.method || request.method || "GET"
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry))
    else headers.set(name, value)
  }
  const protocol = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() || "http"
  const host =
    headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim() || headers.get("host") || "localhost"
  const url = new URL(request.url || "/", `${protocol}://${host}`)
  let body: ReadableStream<Uint8Array> | undefined
  if (method !== "GET" && method !== "HEAD") {
    body = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of request) controller.enqueue(chunk)
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })
  }
  const abort = new AbortController()
  if (request.aborted) abort.abort()
  else request.once("aborted", () => abort.abort())
  return new Request(url, {
    body,
    duplex: body ? "half" : undefined,
    headers,
    method,
    signal: abort.signal,
  } as RequestInit)
}

function normalizeMount(request: Request): Request {
  const url = new URL(request.url)
  const marker = url.pathname.indexOf(consoleDevframeBase)
  if (marker <= 0) return request
  url.pathname = url.pathname.slice(marker)
  return new Request(url, request)
}

function withConsoleHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  headers.set("x-robots-tag", "noindex, nofollow")
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export async function createConsoleDevframeHandler(): Promise<{
  close: () => Promise<void>
  handler: (event: ConsoleRequestEvent) => Promise<Response>
  instance: DevframeInstance
}> {
  const { initDevframe } = await import("devframe/initiate")
  const instance = initDevframe(consoleDevframe, {
    allowedOrigins: false,
    auth: false,
    base: consoleDevframeBase,
    distDir: false,
    mcp: false,
    ws: false,
  })
  return {
    close: instance.close,
    instance,
    async handler(event) {
      setConsoleResponseHeaders(event)
      return withConsoleHeaders(await instance.handler(normalizeMount(webRequest(event))))
    },
  }
}

let consoleHandler: ReturnType<typeof createConsoleDevframeHandler> | undefined

export default async function consoleDevframeHandler(
  event: ConsoleRequestEvent,
): Promise<Response> {
  const resolved = await (consoleHandler ??= createConsoleDevframeHandler())
  return await resolved.handler(event)
}
