import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { defineHandler } from "h3"
import * as v from "valibot"

import { consoleRpcHeader, consoleRpcMethods } from "../rpc.ts"
import consoleAgentsHandler from "./agents.get.ts"
import consoleAgentInvocationsHandler from "./agent-invocations.post.ts"
import { consoleAttachmentRequestBytes } from "./attachments.ts"
import consoleBlobHandler from "./blob.get.ts"
import consoleDatabaseHandler from "./database.get.ts"
import consoleDefinitionsHandler from "./definitions.get.ts"
import consoleInvocationCapabilitiesHandler from "./invocation-capabilities.get.ts"
import consoleInvocationWorkspaceHandler from "./invocation-workspace.get.ts"
import consoleInvocationHandler from "./invocation.get.ts"
import consoleInvocationsHandler from "./invocations.get.ts"
import consoleEnvHandler from "./env.get.ts"
import consoleKVHandler from "./kv.get.ts"
import { consoleRequestError, consoleRequestJSON } from "./request.ts"
import { consoleSearchCollectionHandler } from "./search.get.ts"
import { consoleScheduleRunHandler } from "./schedule-run.ts"
import consoleSectionsHandler from "./sections.get.ts"
import consoleStatusHandler from "./status.get.ts"
import consoleUsageHandler from "./usage.get.ts"

import type { EventHandlerRequest, EventHandlerWithFetch } from "h3"
import type { ConsoleRpcInput, ConsoleRpcMethod, ConsoleRpcResult } from "../rpc.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

export const consoleRpcCallPath = "/_vitehub/rpc/__call"

const maximumConsoleRpcRequestBytes = 64 * 1_024
// Invocation envelopes also carry image data URLs.
const maximumConsoleInvocationRpcRequestBytes = consoleAttachmentRequestBytes + maximumConsoleRpcRequestBytes

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
}

const envelopeSchema = v.object({ input: v.optional(v.unknown()), method: v.string() })
const inputSchema = v.object({
  agent: v.optional(v.string()),
  body: v.optional(v.unknown()),
  id: v.optional(v.string()),
  method: v.optional(v.picklist(["GET", "POST"])),
  query: v.optional(v.record(v.string(), v.union([v.string(), v.array(v.string())]))),
})

interface ConsoleRpcContext {
  env?: Record<string, unknown>
  waitUntil?: (task: Promise<unknown>) => void
}

interface ConsoleOperationContext extends ConsoleRpcContext {
  // Operations set a success status here, such as 202 for an accepted Agent invocation.
  response: { status?: number }
}

function requestEvent(operation: string, input: ConsoleRpcInput, context: ConsoleOperationContext): ConsoleRequestEvent {
  const id = input.id ? `/${encodeURIComponent(input.id)}` : ""
  const url = new URL(`/api/_vitehub/console/${operation}${id}`, "http://vitehub.local")
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, entry))
    else url.searchParams.set(key, value)
  }
  const params: Record<string, string> = {}
  if (input.agent) params.agent = input.agent
  if (input.id) params.id = input.id
  const event: ConsoleRequestEvent = {
    env: context.env,
    context: Object.keys(params).length ? { params } : undefined,
    method: input.method ?? "GET",
    req: {
      json: async () => input.body,
      method: input.method ?? "GET",
      url,
    },
    res: context.response,
  }
  if (context.waitUntil) event.waitUntil = context.waitUntil
  return event
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

async function consoleSearchError(response: Response): Promise<Error> {
  const text = await response.text()
  let message = text
  try {
    const parsed = v.safeParse(v.object({
      statusMessage: v.optional(v.unknown()),
      message: v.optional(v.unknown()),
    }), JSON.parse(text))
    if (parsed.success) {
      const statusMessage = v.safeParse(v.string(), parsed.output.statusMessage)
      const responseMessage = v.safeParse(v.string(), parsed.output.message)
      if (statusMessage.success) message = statusMessage.output
      else if (responseMessage.success) message = responseMessage.output
    }
  }
  catch {
    // Preserve non-JSON upstream responses as-is.
  }
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0052({ message }), {
    statusCode: response.status,
    statusMessage: message,
  })
}

async function result(resolve: () => unknown | Promise<unknown>): Promise<ConsoleRpcResult> {
  try {
    return { ok: true, value: await resolve() }
  } catch (error) {
    return errorResult(error)
  }
}

type ConsoleOperation = (input: ConsoleRpcInput, context: ConsoleOperationContext) => unknown | Promise<unknown>

const operations = new Map<string, ConsoleOperation>(Object.entries({
  [consoleRpcMethods.agents]: (input, context) => consoleAgentsHandler(requestEvent("agents", input, context)),
  [consoleRpcMethods.agentInvocations]: (input, context) => consoleAgentInvocationsHandler(requestEvent(`agents/${input.agent ?? ""}/invocations`, input, context)),
  [consoleRpcMethods.blob]: (input, context) => consoleBlobHandler(requestEvent("blob", input, context)),
  [consoleRpcMethods.database]: (input, context) => consoleDatabaseHandler(requestEvent("database", input, context)),
  [consoleRpcMethods.definitions]: (input, context) => consoleDefinitionsHandler(requestEvent("definitions", input, context)),
  [consoleRpcMethods.invocationWorkspace]: (input, context) => consoleInvocationWorkspaceHandler(requestEvent("invocation-workspace", input, context)),
  [consoleRpcMethods.invocation]: (input, context) => consoleInvocationHandler(requestEvent("invocations", input, context)),
  [consoleRpcMethods.invocationCapabilities]: (input, context) => consoleInvocationCapabilitiesHandler(requestEvent("invocation-capabilities", input, context)),
  [consoleRpcMethods.invocations]: (input, context) => consoleInvocationsHandler(requestEvent("invocations", input, context)),
  [consoleRpcMethods.env]: (input, context) => consoleEnvHandler(requestEvent("env", input, context)),
  [consoleRpcMethods.kv]: (input, context) => consoleKVHandler(requestEvent("kv", input, context)),
  async [consoleRpcMethods.search](input, context) {
    const event = requestEvent("search", input, context)
    const response = await consoleSearchCollectionHandler.fetch(new Request(event.req!.url!, { method: event.method }))
    if (!response.ok) throw await consoleSearchError(response)
    return await response.json()
  },
  [consoleRpcMethods.scheduleRun]: (input, context) => consoleScheduleRunHandler(requestEvent("schedule-run", input, context)),
  [consoleRpcMethods.sections]: (input, context) => consoleSectionsHandler(requestEvent("sections", input, context)),
  [consoleRpcMethods.status]: (input, context) => consoleStatusHandler(requestEvent("status", input, context)),
  [consoleRpcMethods.usage]: (input, context) => consoleUsageHandler(requestEvent("usage", input, context)),
} satisfies Record<ConsoleRpcMethod, ConsoleOperation>))

function isSameOriginRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  // Browsers control Fetch Metadata, which survives trusted TLS termination.
  if (origin === "null" || site === "cross-site" || site === "same-site") return false
  if (site === "same-origin") return true
  if (origin !== null) return origin === url.origin
  // Without origin evidence, require a header that foreign pages cannot send without a CORS preflight.
  return request.headers.get(consoleRpcHeader) === "1"
}

// Accept an application mount prefix, but no other path before or after the Console route.
function isConsoleRpcCallPath(pathname: string): boolean {
  const route = pathname.indexOf("/_vitehub/rpc/")
  return route !== -1 && pathname.slice(route) === consoleRpcCallPath
}

function invocationEnvelopePrefix(body: string): string | undefined {
  // Large invocation calls put the method first so it can be classified within 64 KiB.
  const prefix = /^[ \t\r\n]*\{[ \t\r\n]*"method"[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\]|\\.)*")[ \t\r\n]*(?:,|(?=\}))/.exec(body)
  if (!prefix) return undefined
  return JSON.parse(prefix[1]!) === consoleRpcMethods.agentInvocations ? prefix[0] : undefined
}

async function readConsoleEnvelope(request: Request): Promise<unknown> {
  if (!request.body) return consoleRequestJSON({ req: { json: () => request.json() } }, maximumConsoleRpcRequestBytes)
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let bytes = 0
  let maximumBytes = maximumConsoleRpcRequestBytes
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const remaining = maximumBytes - bytes
      if (chunk.value.byteLength > remaining) {
        // Decode only the bounded prefix before deciding whether attachments are allowed.
        if (maximumBytes === maximumConsoleRpcRequestBytes) {
          body += decoder.decode(chunk.value.subarray(0, remaining), { stream: true })
          if (invocationEnvelopePrefix(body)) maximumBytes = maximumConsoleInvocationRpcRequestBytes
        }
        if (bytes + chunk.value.byteLength > maximumBytes) {
          throw consoleRequestError(413, "Console request body exceeds the byte limit.")
        }
        body += decoder.decode(chunk.value.subarray(remaining), { stream: true })
      }
      else {
        body += decoder.decode(chunk.value, { stream: true })
      }
      bytes += chunk.value.byteLength
    }
    body += decoder.decode()
    const prefix = invocationEnvelopePrefix(body)
    if (!prefix) return JSON.parse(body)
    // Parse the remaining members separately so a duplicate method cannot override
    // the invocation classification and bypass the ordinary request limit.
    const members = v.parse(v.record(v.string(), v.unknown()), JSON.parse(`{${body.slice(prefix.length)}`))
    if (Object.hasOwn(members, "method")) throw consoleRequestError(400, "Invalid Console request.")
    return { ...members, method: consoleRpcMethods.agentInvocations }
  }
  catch (error) {
    await reader.cancel()
    throw error
  }
  finally {
    reader.releaseLock()
  }
}

async function callConsoleOperation(request: Request, context: ConsoleOperationContext): Promise<unknown> {
  const url = new URL(request.url)
  if (!isSameOriginRequest(request, url)) throw consoleRequestError(403, "Forbidden")
  if (!isConsoleRpcCallPath(url.pathname)) throw consoleRequestError(404, "Console RPC endpoint not found.")
  if (request.method !== "POST") throw consoleRequestError(405, "Method not allowed")
  let payload: unknown
  try {
    payload = await readConsoleEnvelope(request)
  }
  catch (error) {
    if (Reflect.get(Object(error), "statusCode") === 413) throw error
    throw consoleRequestError(400, "Malformed Console request.")
  }
  const envelope = v.safeParse(envelopeSchema, payload)
  if (!envelope.success) throw consoleRequestError(400, "Invalid Console request.")
  const operation = operations.get(envelope.output.method)
  if (!operation) throw consoleRequestError(404, "Console operation not found.")
  const input = v.safeParse(inputSchema, envelope.output.input ?? {})
  if (!input.success || Array.isArray(envelope.output.input)) throw consoleRequestError(400, "Invalid Console input.")
  return operation(input.output, context)
}

/** Run one Console operation from one request, so any host instance can serve any call. */
export async function handleConsoleRpcRequest(request: Request, context: ConsoleRpcContext = {}): Promise<Response> {
  const response: ConsoleOperationContext["response"] = {}
  const body = await result(() => callConsoleOperation(request, { ...context, response }))
  return Response.json(body, { headers: responseHeaders, status: body.ok ? response.status ?? 200 : body.status })
}

const consoleRpcHandler: EventHandlerWithFetch<EventHandlerRequest, Promise<Response>> = defineHandler((event) => {
  const waitUntil = resolveWaitUntil(event, { preferHost: true })
  return handleConsoleRpcRequest(event.req, { env: getCloudflareEnv(event, { fallback: false }), waitUntil })
})

export default consoleRpcHandler
