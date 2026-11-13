import { operationAccessAllows, operationListed } from "@vite-hub/internal/operations"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { defineGrant } from "@vite-hub/runtime/internal/grant"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleAuthorizedSections, installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { checkConsoleSignature } from "./console-signature.ts"
import { consoleRequestError, isConsoleDevelopmentRuntime, type ConsoleRequestEvent } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { loadConsoleRuntime } from "./runtime.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleAuthorize, ConsoleUser } from "../../auth-types.ts"
import type { AgentInvoker } from "@vite-hub/agent"
import type { ConsoleSectionId } from "../sections.ts"

export { consoleOpenAccessWarning, installConsoleAccess } from "./access-policy.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `token`: a request signed with a key whose public key is in a `VITEHUB_CONSOLE_KEY_<NAME>` variable. See
 *   `checkConsoleSignature()`. The default.
 * - `open`: no signature, `console: { auth: false }`. Development only. `authorize` runs when it is set.
 * - `local`: the development server without Console options. Production requests fail closed.
 * `impersonation: true` is `console.impersonation`. The Auth section can then start and stop impersonation.
 */
export type ConsoleAccessPolicy =
  | { mode: "open", authorize?: ConsoleAuthorize, impersonation?: boolean }
  | { mode: "local" }
  | { mode: "token", authorize?: ConsoleAuthorize, impersonation?: boolean }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
  /**
   * The sections that this request may use. `"all"` when `console.authorize` is not set or returns `true`. An entry is a
   * section id, or `"<section>:read"` for a section that the request may only read.
   */
  readonly sections: "all" | readonly string[]
  /** The person who called: the signed Console user, or the local developer on a development server. */
  readonly user?: ConsoleUser
  /** Who signed the request: the ViteHub Console or the CLI. Not set for an open Console. */
  readonly via?: "console" | "cli"
  /** The Console team of a signed request from the Console, and the role of the user in it. */
  readonly team?: { readonly id: string, readonly role?: string }
  /**
   * `"mcp"` when the ViteHub MCP of the Console signed the request for the user. The RPC then refuses operations with
   * `mcp: false`, runs the others with the `mcp` surface, and refuses a destructive call that is not `confirmed`.
   */
  readonly surface?: "mcp"
  /** The person agreed to this destructive MCP call. The signature covers it. */
  readonly confirmed?: boolean
  /**
   * The signed request: the name of its key, and the SHA-256 of the body that the signature covers. The reader of the
   * body compares the digest before it acts on the body.
   */
  readonly signature?: { readonly key: string, readonly bodySha256: string }
}

/**
 * The Console section that a guarded route belongs to.
 * - `section`: a section id, or a function that reads it from the request. A request outside the allowed sections gets `403`.
 * - `anySection: true`: the route serves every Console user, such as the section list and the RPC transport.
 * - `write: true`: the route changes state, so a read-only grant (`"<section>:read"`) is refused.
 */
export type ConsoleRouteScope =
  | { section: ConsoleSectionId | ((event: ConsoleRequestEvent) => ConsoleSectionId | undefined), write?: boolean }
  | { anySection: true }

/** A Console server handler that runs only after `withConsoleAccess()` accepts the request. */
export type ConsoleGuardedHandler<TEvent, TResult> = (event: TEvent, access: ConsoleAccess) => TResult | Promise<TResult>

/** The route that `withConsoleAccess()` returns for a handler. Route files use it to type their default export. */
export type ConsoleAccessRoute<THandler extends (event: never, access: ConsoleAccess) => unknown> = (event: Parameters<THandler>[0]) => Promise<Awaited<ReturnType<THandler>> | Response>

const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
// Keyed by the Request of the Standard Context, so an H3 middleware and the Fetchable route of one request share it.
const checkedRequests = new WeakMap<Request, ConsoleAccess>()
const routeScopes = new WeakMap<object, ConsoleRouteScope>()

/** A JSON rejection with the Console diagnostic fields: `code`, `message` (the why), `fix`, and `docs`. */
function rejection(status: number, code: ConsoleDiagnosticCode, message?: string): Response {
  return Response.json({ ...consoleDiagnosticBody(code, message), ok: false, status }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status,
  })
}

/** Whether `console.impersonation` is on. Without it, the Console has no impersonation route or action. */
export function consoleImpersonation(): boolean {
  const policy = installedConsoleAccessPolicy()
  return Boolean(policy && "impersonation" in policy && policy.impersonation === true)
}

/**
 * The Fetch request passed to Console authorization and runtime contexts: the request in the event's Standard Context.
 * For the Request of a Console route, it is the same Request.
 */
export function consoleRequest(event: ConsoleRequestEvent | Request): Request {
  return getStandardContext(event).req
}

function assertRouteScope(routeScope: unknown): asserts routeScope is ConsoleRouteScope {
  if (!(routeScope instanceof Object)) throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
  if ("section" in routeScope) {
    const section = routeScope.section
    if (typeof section === "function" || (typeof section === "string" && section.length > 0)) return
  }
  if ("anySection" in routeScope && routeScope.anySection === true) return
  throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
}

async function checkConsoleAccess(event: ConsoleRequestEvent): Promise<ConsoleAccess | Response> {
  const policy = installedConsoleAccessPolicy()
  if (!policy) return rejection(500, "CONSOLE_ACCESS_NOT_CONFIGURED", "Console access is not configured. The generated Console output did not install an access policy.")
  // Every Console route and Realtime room reads its access here, so none can skip this rule.
  if (!await isConsoleLoopbackRequest(consoleRequest(event), { access: policy.mode, remoteAddress: getStandardContext(event).runtime?.clientAddress })) {
    return rejection(403, "CONSOLE_LOOPBACK_ONLY")
  }
  let user: ConsoleUser | undefined
  let via: ConsoleAccess["via"]
  let team: ConsoleAccess["team"]
  let surface: ConsoleAccess["surface"]
  let confirmed: ConsoleAccess["confirmed"]
  let signature: ConsoleAccess["signature"]
  if (policy.mode === "local") {
    if (!isConsoleDevelopmentRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  }
  else if (policy.mode === "token") {
    // A signature is the only way in. A cookie, a session, or a bearer token never counts.
    const signed = await checkConsoleSignature(consoleRequest(event), event)
    if (!signed.ok) return signed.response
    via = signed.caller.via
    signature = { key: signed.key, bodySha256: signed.bodySha256 }
    if (signed.caller.via === "console") {
      user = { ...signed.caller.user }
      team = signed.caller.team
      surface = signed.caller.surface
      confirmed = signed.caller.confirmed
    }
  }
  let sections: ConsoleAccess["sections"] = "all"
  if (policy.mode !== "local" && policy.authorize) {
    const request = consoleRequest(event)
    const result: unknown = await policy.authorize(
      signature && via === "cli"
        ? { key: signature.key, request, via }
        : signature && via === "console" && user
          ? { key: signature.key, request, user, via, ...(team ? { team } : {}), ...(surface ? { surface } : {}) }
          : { request },
    )
    if (isRuntimeResponse(result)) return result
    if (result === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    if (result !== true) {
      const allowed = consoleAuthorizedSections(result)
      if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED", "console.authorize must return true, false, a Response, or { sections: string[] }.")
      if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
      sections = allowed
    }
  }
  return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections, ...(user ? { user } : {}), ...(via ? { via } : {}), ...(team ? { team } : {}), ...(surface ? { surface } : {}), ...(confirmed ? { confirmed } : {}), ...(signature ? { signature } : {}) })
}

/** The person of a checked access, or `undefined` for an access that the check did not create. */
export function readConsoleAccessUser(access: ConsoleAccess): ConsoleUser | undefined {
  return consoleAccessGrant.isValid(access) ? access.user : undefined
}

/** The person of a checked access as plain text fields: the signed Console user, or `undefined` without one. */
export function consolePerson(access: ConsoleAccess): { id: string, email?: string, name?: string } | undefined {
  const user = readConsoleAccessUser(access)
  if (!user?.id) return undefined
  const email: unknown = user.email
  const name: unknown = user.name
  return {
    id: user.id,
    ...(typeof email === "string" && email ? { email } : {}),
    ...(typeof name === "string" && name ? { name } : {}),
  }
}

/**
 * The user that an operation sees. A development server without sign-in (`local` access, or `open` with
 * `console.auth: false`) has no accounts, so the person is the local developer: `{ id: "local", name: "You" }`.
 * Production servers never invent a user.
 */
export async function readConsoleOperationUser(access: ConsoleAccess): Promise<ConsoleUser | undefined> {
  const user = readConsoleAccessUser(access)
  if (user) return user
  // SAFETY: The local developer has the id and name that a Console user needs.
  return (access.mode === "local" || access.mode === "open") && isConsoleDevelopmentRuntime() ? { id: "local", name: "You" } as ConsoleUser : undefined
}

/** Whether the access includes the section, with a read-only grant (`"<section>:read"`) too. */
export function consoleAccessAllows(access: ConsoleAccess, section: ConsoleSectionId | undefined): boolean {
  if (!consoleAccessGrant.isValid(access)) return false
  return operationAccessAllows(access, section)
}

/** Whether the access may change the section: it has the full grant, not `"<section>:read"`. */
export function consoleAccessWrites(access: ConsoleAccess, section: ConsoleSectionId | undefined): boolean {
  if (!consoleAccessGrant.isValid(access)) return false
  return operationAccessAllows(access, section, { kind: "write" })
}

/**
 * Whether the section grants of the access allow the kind of the operation, for a list of what it may call. An operation
 * with `readOnlyWhen` shows with a read-only grant, because some of its calls only read. Each call checks again.
 */
export function consoleOperationGranted(access: ConsoleAccess, operation: AnyOperation): boolean {
  return operationListed(access, operation, operation.readOnlyWhen ? undefined : operation)
}

export function allowedConsoleSections(access: ConsoleAccess, available: readonly ConsoleSectionId[]): ConsoleSectionId[] {
  return available.filter(section => consoleAccessAllows(access, section))
}

/** Map the verified Console user to the Agent Invoker used by invocations and replay. */
export function consoleAccessInvoker(user: ConsoleUser | undefined): AgentInvoker | undefined {
  if (!user?.id) return undefined
  const label = "email" in user && typeof user.email === "string" && user.email
    ? user.email
    : "name" in user && typeof user.name === "string" && user.name
      ? user.name
      : user.id
  return { id: user.id, kind: "authUser", label, meta: { authUserId: user.id } }
}

/** The person in a Realtime room that the Console opened. */
export interface ConsoleRealtimeUser {
  id: string
  name?: string
  email?: string
  image?: string
}

/** Identity and access of Realtime rooms that a Console section opens, such as Content live editing. */
export interface ConsoleRealtimeAccess {
  /** The Console user, or a guest of an open Console. Null without Console access. */
  identify(context: { event: unknown }): Promise<ConsoleRealtimeUser | null>
  /** Whether the request includes the section; writes require its full grant instead of a read-only grant. */
  authorize(context: { event: unknown, kind?: "read" | "write" }): Promise<boolean>
  /** The Console user that owner policies, such as `content.can()`, get: the same user as Console actions, or null. */
  user(context: { event: unknown }): Promise<ConsoleUser | null>
}

function text(value: unknown): string | undefined {
  return String(value) === value && value ? value : undefined
}

/**
 * Identity and access of the Realtime rooms that one Console section opens, from the installed Console access policy.
 * Content live editing uses it, so a room trusts the same session, Cloudflare Access token, or open mode as the
 * Console, and checks the same section access.
 */
export function consoleRealtimeAccess(section: ConsoleSectionId): ConsoleRealtimeAccess {
  const checked = new WeakMap<object, Promise<ConsoleAccess | undefined>>()
  function access(event: unknown): Promise<ConsoleAccess | undefined> {
    if (!(event instanceof Object)) return Promise.resolve(undefined)
    let pending = checked.get(event)
    if (!pending) {
      // SAFETY: Realtime passes the H3 event of the WebSocket or HTTP request, which has the members the check reads.
      const consoleEvent = event as ConsoleRequestEvent
      pending = checkConsoleAccess(consoleEvent).then(result => isRuntimeResponse(result) || !consoleAccessAllows(result, section) ? undefined : result)
      checked.set(event, pending)
    }
    return pending
  }
  return {
    async identify({ event }) {
      const allowed = await access(event)
      if (!allowed) return null
      const user = readConsoleAccessUser(allowed)
      const id = text(user?.id) ?? text(user?.email)
      if (user && id) {
        const person: ConsoleRealtimeUser = { id }
        const name = text(user.name) ?? text(user.email)
        if (name) person.name = name
        if (text(user.email)) person.email = text(user.email)
        if (text(user.image)) person.image = text(user.image)
        return person
      }
      // An open Console has no accounts: each connection is a guest.
      return { id: `guest-${crypto.randomUUID()}`, name: "Guest" }
    },
    async authorize({ event, kind }) {
      const allowed = await access(event)
      return Boolean(allowed && (kind !== "write" || consoleAccessWrites(allowed, section)))
    },
    async user({ event }) {
      const allowed = await access(event)
      return allowed ? readConsoleAccessUser(allowed) ?? null : null
    },
  }
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request, and after the
 * Console runtime has loaded. Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
  routeScope: ConsoleRouteScope,
): (event: TEvent) => Promise<TResult | Response> {
  if (typeof handler !== "function") throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  assertRouteScope(routeScope)
  const declared = Object.freeze({ ...routeScope }) as ConsoleRouteScope
  const route = async (event: TEvent) => {
    const request = consoleRequest(event)
    let access = checkedRequests.get(request)
    if (!access || !consoleAccessGrant.isValid(access)) {
      const checked = await checkConsoleAccess(event)
      // A Response from another realm fails `instanceof`. It is a denial, not an access grant.
      if (isRuntimeResponse(checked)) return checked
      access = checked
      checkedRequests.set(request, access)
    }
    if ("section" in declared) {
      const section = typeof declared.section === "function" ? declared.section(event) : declared.section
      // A dynamic scope that cannot resolve to a section is not an unrestricted route.
      if (section === undefined || !consoleAccessAllows(access, section)) return rejection(403, "CONSOLE_ACCESS_DENIED")
      if (declared.write === true && !consoleAccessWrites(access, section)) return rejection(403, "CONSOLE_ACCESS_DENIED")
    }
    // Only an accepted request loads the Console runtime, so a rejected one costs no more than the check.
    await loadConsoleRuntime()
    return handler(event, access)
  }
  routeScopes.set(route, declared)
  return route
}

export function consoleRouteScope(route: unknown): ConsoleRouteScope | undefined {
  return typeof route === "function" ? routeScopes.get(route) : undefined
}

/** Adapt an in-process agent call by checking the installed policy for its user. HTTP callers still need a Console grant. */
export async function consoleOperationAccess(context: OperationContext): Promise<ConsoleAccess> {
  // SAFETY: The private grant registry proves this access came from the Console check.
  if (consoleAccessGrant.isValid(context.access)) return context.access as ConsoleAccess
  const policy = installedConsoleAccessPolicy()
  if (!policy || context.surface !== "agent" || context.access.mode !== "agent") {
    throw consoleRequestError(403, "This Console access was not created by the access check.")
  }
  let allowed: ConsoleAccess["sections"] = "all"
  if (policy.mode !== "local" && policy.authorize) {
    const request = new Request("http://vitehub.local/_vitehub/rpc", { method: "POST" })
    const result = await policy.authorize({ request, via: "agent", ...(context.user ? { user: context.user } : {}) })
    if (result !== true) {
      const sections = consoleAuthorizedSections(result)
      if (!sections?.length) throw consoleRequestError(403, "This user cannot use Console operations.")
      allowed = sections
    }
  }
  const candidates = context.access.sections === "all" ? allowed : context.access.sections
  const checked = { mode: policy.mode, sections: allowed }
  const sections = candidates === "all" ? "all" : candidates.flatMap((entry) => {
    const section = entry.endsWith(":read") ? entry.slice(0, -5) : entry
    if (!operationAccessAllows(checked, section)) return []
    return [entry.endsWith(":read") || !operationAccessAllows(checked, section, { kind: "write" }) ? `${section}:read` : section]
  })
  return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections, ...(context.user ? { user: context.user } : {}) })
}

/**
 * Bind a checked Console access to an internal event, such as one Console RPC operation, through the Request of its
 * Standard Context. A guarded handler that receives this event uses the bound access. Rejects an access that
 * `withConsoleAccess()` did not create.
 */
export function bindConsoleAccess<TEvent extends ConsoleRequestEvent>(access: ConsoleAccess, event: TEvent): TEvent {
  if (!consoleAccessGrant.isValid(access)) throw consoleRequestError(403, "This Console access was not created by the access check.")
  const request = consoleRequest(event)
  if (checkedRequests.has(request)) throw consoleRequestError(500, "Console access is already bound to this request.")
  checkedRequests.set(request, access)
  return event
}
