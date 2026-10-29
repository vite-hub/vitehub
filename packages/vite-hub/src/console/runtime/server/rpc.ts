import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { assertOperationConfirmation, assertOperationProject, operationAccessAllows, operationCall, operationRootHeader, operationSection, operationSurfaceHeader, parseOperationInput, projectRootHash } from "@vite-hub/internal/operations"
import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"
import * as v from "valibot"

import { consoleRpcHeader } from "../rpc.ts"
import { consoleAccessAllows, consoleAccessWrites, readConsoleOperationUser, withConsoleAccess, type ConsoleAccess } from "./access.ts"
import { assertLoopbackWithoutSignIn, eventRemoteAddress } from "./loopback.ts"
import { consoleDiagnosticBody, consoleStatusDiagnosticCode } from "../diagnostics.ts"
import { consoleOperationRegistry, installedConsoleProjectRoot } from "./operation-contributions.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"
import { uploadConsoleMedia } from "./media.ts"
import { consoleRequestError, consoleRequestJSON } from "./request.ts"

import type { H3Event } from "h3"
import type { OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleRpcResult } from "../rpc.ts"

export const consoleRpcCallPath = "/_vitehub/rpc/__call"
/** Media library uploads: one file per `multipart/form-data` request, so the browser can report progress. */
export const consoleRpcUploadPath = "/_vitehub/rpc/__upload"

const maximumConsoleRpcRequestBytes = 64 * 1_024

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
}

const envelopeSchema = v.object({ input: v.optional(v.unknown()), operation: v.string() })

interface ConsoleRpcContext {
  /** The checked access of the RPC request. Each operation runs with it. */
  access: ConsoleAccess
  env?: Record<string, unknown>
  /** The address of the peer, when the host exposes it. */
  remoteAddress?: string
  waitUntil?: (task: Promise<unknown>) => void
}

interface ConsoleOperationContext extends ConsoleRpcContext {
  // Operations set a success status here, such as 202 for an accepted Agent invocation.
  response: { status?: number }
}

function errorResult(error: unknown): ConsoleRpcResult {
  const value = Object(error)
  const rawStatus = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const statusMessage = Reflect.get(value, "statusMessage")
  const message = typeof statusMessage === "string" ? statusMessage : error instanceof Error ? error.message : undefined
  // Owner action failures, such as CONTENT_INVALID, carry their code and JSON details. See consoleActionError().
  const ownerCode = text(Reflect.get(value, "consoleCode"))
  if (ownerCode) {
    const failure: Extract<ConsoleRpcResult, { ok: false }> = { code: ownerCode, message: message ?? "Console request failed.", ok: false, status }
    const details: unknown = Reflect.get(value, "consoleDetails")
    if (details instanceof Object && !Array.isArray(details)) Object.assign(failure, { details })
    return failure
  }
  // A failure site with its own diagnostic keeps its code and guidance. Others get the Console code of the status.
  const code = text(Reflect.get(value, "code"))
  if (!code) return { ...consoleDiagnosticBody(consoleStatusDiagnosticCode(status), message), ok: false, status }
  const result: Extract<ConsoleRpcResult, { ok: false }> = { code, message: message ?? "Console request failed.", ok: false, status }
  const fix = text(Reflect.get(value, "fix"))
  const docs = text(Reflect.get(value, "docs"))
  const details: unknown = Reflect.get(value, "details")
  if (fix) result.fix = fix
  if (docs) result.docs = docs
  // Server failures keep their details out of the response. Input and conflict failures name what to fix.
  if (status < 500 && details instanceof Object && !Array.isArray(details)) Object.assign(result, { details })
  return result
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

async function result(resolve: () => unknown | Promise<unknown>): Promise<ConsoleRpcResult> {
  try {
    return { ok: true, value: await resolve() }
  } catch (error) {
    return errorResult(error)
  }
}

export { consoleOperationRegistry }

/** The Console section of each RPC operation, for inspection and tests. `false` marks an operation that every Console user may call. */
export function consoleRpcOperationSection(name: string, input: unknown = {}): string | false | undefined {
  const operation = consoleOperationRegistry().get(name)
  return operation ? operationSection(operation, input) : undefined
}

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
function isConsoleRpcPath(pathname: string, path: string): boolean {
  const route = pathname.indexOf("/_vitehub/rpc/")
  return route !== -1 && pathname.slice(route) === path
}

function largeEnvelopePrefix(body: string): { maximumBytes: number, operation: string, prefix: string } | undefined {
  // Large calls put the operation first so they can be classified within 64 KiB.
  const prefix = /^[ \t\r\n]*\{[ \t\r\n]*"operation"[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\]|\\.)*")[ \t\r\n]*(?:,|(?=\}))/.exec(body)
  if (!prefix) return undefined
  const operation: unknown = JSON.parse(prefix[1]!)
  if (String(operation) !== operation) return undefined
  const maximumBytes = consoleOperationRegistry().get(operation)?.maxRequestBytes
  if (maximumBytes === undefined || maximumBytes <= maximumConsoleRpcRequestBytes) return undefined
  return { maximumBytes, operation, prefix: prefix[0] }
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
          maximumBytes = largeEnvelopePrefix(body)?.maximumBytes ?? maximumBytes
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
    const large = largeEnvelopePrefix(body)
    if (!large) return JSON.parse(body)
    // Parse the remaining members separately so a duplicate operation cannot override
    // the classification and bypass the ordinary request limit.
    const members = v.parse(v.record(v.string(), v.unknown()), JSON.parse(`{${body.slice(large.prefix.length)}`))
    if (Object.hasOwn(members, "operation")) throw consoleRequestError(400, "Invalid Console request.")
    return { ...members, operation: large.operation }
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
  if (!isSameOriginRequest(request, url)) throw consoleRequestError(403, "Cross-origin Console requests are not allowed.", "CONSOLE_ORIGIN_REJECTED")
  assertLoopbackWithoutSignIn(request, url, context)
  assertOperationProject(request, installedConsoleProjectRoot())
  if (isConsoleRpcPath(url.pathname, consoleRpcUploadPath)) {
    if (request.method !== "POST") throw consoleRequestError(405, "Method not allowed")
    const section = url.searchParams.get("section") ?? ""
    if (!consoleAccessWrites(context.access, section)) throw consoleRequestError(403, "This Console access does not include this section, or only reads it.")
    return uploadConsoleMedia(request, section, context.access)
  }
  if (!isConsoleRpcPath(url.pathname, consoleRpcCallPath)) throw consoleRequestError(404, "Console RPC endpoint not found.")
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
  const operation = consoleOperationRegistry().get(envelope.output.operation)
  if (!operation) throw consoleRequestError(404, "Console operation not found.")
  if (Array.isArray(envelope.output.input)) throw consoleRequestError(400, "Invalid Console input.")
  // A failed check throws INTERNAL_R0022 with status 400, which names the fields to fix.
  const input = await parseOperationInput(operation, envelope.output.input)
  const section = operationSection(operation, input)
  if (section !== false && !consoleAccessAllows(context.access, section)) {
    throw consoleRequestError(403, "This Console access does not include this section.")
  }
  const classification = operationCall(operation, input)
  // A read-only grant (`"<section>:read"`) runs only the operations, and the calls, that read.
  if (section !== false && !operationAccessAllows(context.access, section, classification)) {
    throw consoleRequestError(403, `This Console access to the "${section}" section is read-only, and ${operation.name} is a ${operation.kind} operation.`, "CONSOLE_ACCESS_DENIED")
  }
  assertOperationConfirmation(request, classification)
  // Navigation and other reads that do not need a person skip the session lookup.
  const user = operation.user === false ? undefined : await readConsoleOperationUser(context.access)
  const operationContext: OperationContext = {
    access: context.access,
    development: isConsoleDevelopmentBuild(),
    request,
    response: context.response,
    // The CLI names itself. Only the unauthenticated `local` access of `vite dev` trusts it more than the Console.
    surface: request.headers.get(operationSurfaceHeader) === "cli" ? "cli" : "console",
    // SAFETY: A Console user from the Auth adapter has the id that the operation user needs.
    user: user ? user as OperationContext["user"] : null,
    ...(context.env ? { env: context.env } : {}),
    ...(context.waitUntil ? { waitUntil: context.waitUntil } : {}),
  }
  // SAFETY: The schema of the operation produced `input`.
  return (operation.run as (value: unknown, context: OperationContext) => unknown)(input, operationContext)
}

/** Run one Console operation from one checked request, so any host instance can serve any call. */
export async function handleConsoleRpcRequest(request: Request, context: ConsoleRpcContext): Promise<Response> {
  const response: ConsoleOperationContext["response"] = {}
  const body = await result(() => callConsoleOperation(request, { ...context, response }))
  // The local dev RPC names its project, so a command can tell that it reached the wrong dev server.
  const root = context.access.mode === "local" ? installedConsoleProjectRoot() : undefined
  return Response.json(body, { headers: root ? { ...responseHeaders, [operationRootHeader]: projectRootHash(root) } : responseHeaders, status: body.ok ? response.status ?? 200 : body.status })
}

// A plain handler, because Nuxt 4 bundles every `h3` import as its own h3 1, which has no `defineHandler()`.
const consoleRpcHandler: (event: H3Event) => Promise<Response> = withConsoleAccess((event: H3Event, access) => {
  const waitUntil = resolveWaitUntil(event, { preferHost: true })
  return handleConsoleRpcRequest(toEventRequest(event), { access, env: getCloudflareEnv(event, { fallback: false }), remoteAddress: eventRemoteAddress(event), waitUntil })
  // Each operation checks its own section.
}, { anySection: true })

export default consoleRpcHandler
