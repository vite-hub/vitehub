import { consoleBodySha256 } from "@vite-hub/internal/console-signature"
import { answerOperationRpc, operationRpcRefusal, readOperationRpcCall } from "@vite-hub/internal/operation-rpc"
import { assertOperationConfirmation, assertOperationConfirmed, assertOperationProject, operationAccessAllows, operationAccessDenial, operationCall, operationRootHeader, operationSection, operationSurfaceHeader, parseOperationInput, projectRootHash } from "@vite-hub/internal/operations"
import { getStandardContext } from "@vite-hub/runtime/h3"
import * as v from "valibot"

import { consoleRpcHeader } from "../rpc.ts"
import { consoleAccessAllows, readConsoleOperationUser, withConsoleAccess, type ConsoleAccess } from "./access.ts"
import { isConsoleRpcPath } from "./console-signature.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { installedConsoleProjectRoot } from "./project-root.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"
import { consoleErrorResult, consoleRequestError, consoleRoute } from "./request.ts"

import type { ConsoleRoute } from "./request.ts"
import type { OperationRpcCall, OperationRpcReply } from "@vite-hub/internal/operation-rpc"
import type { AnyOperation, OperationContext, OperationFailure, OperationRegistry } from "@vite-hub/internal/operations"

const maximumConsoleRpcRequestBytes = 64 * 1_024

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
}

interface ConsoleRpcContext {
  /** The checked access of the RPC request. Each operation runs with it. */
  access: ConsoleAccess
  env?: Record<string, unknown>
  /** The server event of the request, for operations that read the app's own session. */
  event?: unknown
  waitUntil?: (task: Promise<unknown>) => void
}

interface ConsoleOperationContext extends ConsoleRpcContext {
  // Operations set a success status here, such as 202 for an accepted Agent invocation.
  response: { headers?: Headers, status?: number }
}

const operationTables = new WeakMap<OperationRegistry, Readonly<Record<string, AnyOperation>>>()

/** The operations by name, as own keys, for the birpc resolver. */
function consoleOperationTable(): Readonly<Record<string, AnyOperation>> {
  const registry = consoleOperationRegistry()
  let table = operationTables.get(registry)
  if (!table) {
    table = Object.fromEntries(registry.list().map(operation => [operation.name, operation]))
    operationTables.set(registry, table)
  }
  return table
}

/** The diagnostic of a failed call: the fields of the Console error body, without `ok` and never with the stack. */
function consoleRpcFailure(error: unknown): OperationFailure {
  const { ok: _ok, ...failure } = consoleErrorResult(error)
  return failure
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

function largeEnvelopePrefix(body: string): { maximumBytes: number, operation: string, prefix: string } | undefined {
  // birpc writes the method name `m` first, so a large call can be classified within 64 KiB.
  const prefix = /^[ \t\r\n]*\{[ \t\r\n]*"m"[ \t\r\n]*:[ \t\r\n]*("(?:[^"\\]|\\.)*")[ \t\r\n]*(?:,|(?=\}))/.exec(body)
  if (!prefix) return undefined
  const operation: unknown = JSON.parse(prefix[1]!)
  if (String(operation) !== operation) return undefined
  const maximumBytes = consoleOperationRegistry().get(operation)?.maxRequestBytes
  if (maximumBytes === undefined || maximumBytes <= maximumConsoleRpcRequestBytes) return undefined
  return { maximumBytes, operation, prefix: prefix[0] }
}

/**
 * Read the birpc message of a request, within the byte limit of its operation. `bodySha256` is the digest that the
 * signature of a signed request covers: the bytes must match it before the message is parsed.
 */
async function readConsoleEnvelope(request: Request, bodySha256?: string): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Request body is unavailable.")
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let body = ""
  let bytes = 0
  let maximumBytes = maximumConsoleRpcRequestBytes
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (bodySha256) chunks.push(chunk.value)
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
    if (bodySha256) {
      const all = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.byteLength
      }
      if (await consoleBodySha256(all) !== bodySha256) throw consoleRequestError(401, "The request body is not the body that was signed.", "CONSOLE_SIGNATURE_BODY")
    }
    const large = largeEnvelopePrefix(body)
    if (!large) return JSON.parse(body)
    // Parse the remaining members separately so a duplicate method name cannot override
    // the classification and bypass the ordinary request limit.
    const members = v.parse(v.record(v.string(), v.unknown()), JSON.parse(`{${body.slice(large.prefix.length)}`))
    if (Object.hasOwn(members, "m")) throw consoleRequestError(400, "Invalid Console request.")
    return { m: large.operation, ...members }
  }
  catch (error) {
    await reader.cancel()
    throw error
  }
  finally {
    reader.releaseLock()
  }
}

/** Check the request and read its one birpc call. A failure here has no call id. */
async function readConsoleCall(request: Request, access: ConsoleAccess): Promise<OperationRpcCall> {
  const url = new URL(request.url)
  // A browser cannot sign, so a signed call needs no browser check. A call without a signature must come from a page of
  // the app itself, or from a client that sends a header that other pages cannot send without a CORS preflight.
  if (access.mode !== "token" && !isSameOriginRequest(request, url)) throw consoleRequestError(403, "Cross-origin Console requests are not allowed.", "CONSOLE_ORIGIN_REJECTED")
  assertOperationProject(request, installedConsoleProjectRoot())
  if (!isConsoleRpcPath(url.pathname)) throw consoleRequestError(404, "Console RPC endpoint not found.")
  if (request.method !== "POST") throw consoleRequestError(405, "Method not allowed")
  let payload: unknown
  try {
    payload = await readConsoleEnvelope(request, access.signature?.bodySha256)
  }
  catch (error) {
    const status = Reflect.get(Object(error), "statusCode")
    if (status === 413 || status === 401) throw error
    throw consoleRequestError(400, "Malformed Console request.")
  }
  // One HTTP request answers one call, so an event without an id or an optional call is refused.
  const call = readOperationRpcCall(payload)
  if (!call) throw consoleRequestError(400, "Invalid Console request.")
  return call
}

async function runConsoleOperation(operation: AnyOperation, rawInput: unknown, request: Request, context: ConsoleOperationContext): Promise<unknown> {
  if (Array.isArray(rawInput)) throw consoleRequestError(400, "Invalid Console input.")
  // The ViteHub MCP of the Console signs its calls as `mcp`. They get the rules of an MCP client, such as the in-app MCP.
  const mcp = context.access.surface === "mcp"
  if (mcp && operation.mcp === false) throw consoleRequestError(403, `${operation.name} is not open to MCP clients. Use it from the Console.`, "CONSOLE_ACCESS_DENIED")
  // A failed check throws INTERNAL_R0022 with status 400, which names the fields to fix.
  const input = await parseOperationInput(operation, rawInput)
  const section = operationSection(operation, input)
  if (section !== false && !consoleAccessAllows(context.access, section)) {
    const denial = operationAccessDenial(operation.name, section)
    throw consoleRequestError(403, `${denial.message} ${denial.fix}`, "CONSOLE_ACCESS_DENIED")
  }
  const classification = operationCall(operation, input)
  // A read-only grant (`"<section>:read"`) runs only the operations, and the calls, that read.
  if (section !== false && !operationAccessAllows(context.access, section, classification)) {
    throw consoleRequestError(403, `This Console access to the "${section}" section is read-only, and ${operation.name} is a ${operation.kind} operation.`, "CONSOLE_ACCESS_DENIED")
  }
  assertOperationConfirmation(request, classification)
  // An MCP call is unconfirmed unless the signed caller says that the person agreed.
  if (mcp) assertOperationConfirmed(classification, context.access.confirmed === true)
  // Navigation and other reads that do not need a person skip the session lookup.
  const user = operation.user === false ? undefined : await readConsoleOperationUser(context.access)
  const operationContext: OperationContext = {
    access: context.access,
    development: isConsoleDevelopmentBuild(),
    request,
    response: context.response,
    // A signed request names its signer. Without a signature, the CLI names itself with a header; only the
    // unauthenticated `local` access of `vite dev` trusts it more than the Console.
    surface: mcp ? "mcp" : context.access.via === "cli" || context.access.via === "console" ? context.access.via : request.headers.get(operationSurfaceHeader) === "cli" ? "cli" : "console",
    // SAFETY: A Console user from the Auth adapter has the id that the operation user needs.
    user: user ? user as OperationContext["user"] : null,
    ...(context.env ? { env: context.env } : {}),
    ...(context.event ? { event: context.event } : {}),
    ...(context.waitUntil ? { waitUntil: context.waitUntil } : {}),
  }
  // SAFETY: The schema of the operation produced `input`.
  return (operation.run as (value: unknown, context: OperationContext) => unknown)(input, operationContext)
}

/**
 * Answer one birpc call from one checked request, so any host instance can serve any call. The status is the status of
 * the failure, or the success status that the operation set, such as 202.
 */
export async function handleConsoleRpcRequest(request: Request, context: ConsoleRpcContext): Promise<Response> {
  const response: ConsoleOperationContext["response"] = {}
  let reply: OperationRpcReply
  try {
    const call = await readConsoleCall(request, context.access)
    reply = await answerOperationRpc(call, {
      failure: consoleRpcFailure,
      operations: consoleOperationTable(),
      run: (operation, input) => runConsoleOperation(operation, input, request, { ...context, response }),
      unknown: () => consoleRequestError(404, "Console operation not found."),
    })
  }
  catch (error) {
    reply = operationRpcRefusal(consoleRpcFailure(error))
  }
  // The local dev RPC names its project, so a command can tell that it reached the wrong dev server.
  const root = context.access.mode === "local" ? installedConsoleProjectRoot() : undefined
  const headers = new Headers(responseHeaders)
  response.headers?.forEach((value, name) => headers.set(name, value))
  if (root) headers.set(operationRootHeader, projectRootHash(root))
  return Response.json(reply, { headers, status: "e" in reply ? reply.e.status : response.status ?? 200 })
}

const guardedRpc = withConsoleAccess((event, access) => {
  const { req, runtime, waitUntil } = getStandardContext(event)
  return handleConsoleRpcRequest(req, { access, env: runtime?.cloudflare?.env, event, waitUntil })
}, { anySection: true })

/**
 * `<base>/_vitehub/rpc`: one Console operation for each signed `POST`. Each operation checks its own section. A browser
 * that opens `GET <base>/_vitehub/rpc?ticket=<ticket>` redeems a one-time ticket that an operation made, such as for
 * impersonation. The ticket is the only proof that a `GET` needs. See `tickets.ts`.
 */
const consoleRpcRoute: ConsoleRoute = consoleRoute(async (event) => {
  const request = getStandardContext(event).req
  if (request.method === "GET" && new URL(request.url).searchParams.has("ticket")) return (await import("./tickets.ts")).redeemConsoleTicket(event)
  return guardedRpc(event)
})

export default consoleRpcRoute
