import { operationAccessAllows, operationListed } from "@vite-hub/internal/operations"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { defineGrant } from "@vite-hub/runtime/internal/grant"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleMountBase } from "../console-route.ts"
import { consoleAuthorizedSections, installedConsoleAccessPolicy } from "./access-policy.ts"
import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleChallenge, consoleMcpReadScope, consoleMcpWriteScope, isConsoleDataPath, markBearerRejection, mcpChallenge, resolveConsoleOAuth, verifyConsoleBearer, type ConsoleBearerResult, type ConsoleOAuthConfig } from "./bearer.ts"
import { checkConsoleToken } from "./console-token.ts"
import { withListedConsoleOrigin, withResponseHeaders } from "./cors.ts"
import { consoleRequestError, consoleRequestURL, isConsoleDevelopmentRuntime, type ConsoleRequestEvent } from "./request.ts"
import { isConsoleLoopbackRequest } from "./loopback.ts"
import { loadConsoleRuntime } from "./runtime.ts"

import type { AnyOperation, OperationCallKind, OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleAuthorize, ConsoleUser } from "../../auth-types.ts"
import type { AgentInvoker } from "@vite-hub/agent"
import type { ConsoleSectionId } from "../sections.ts"

export { consoleOpenAccessWarning, installConsoleAccess } from "./access-policy.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `open`: no sign-in. `authorize` runs when it is set.
 * - `local`: the development server only. Production requests fail closed.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * - `token`: `Authorization: Bearer` with a token whose SHA-256 is in `VITEHUB_CONSOLE_TOKEN_SHA256`. See `checkConsoleToken()`.
 * `impersonation: true` is `console.impersonation`. The Auth section can then start and stop impersonation.
 */
export type ConsoleAccessPolicy =
  | { mode: "open", authorize?: ConsoleAuthorize, impersonation?: boolean }
  | { mode: "local" }
  | { mode: "token", authorize?: ConsoleAuthorize }
  | {
    mode: "auth" | "cloudflare-access"
    authorize?: ConsoleAuthorize
    impersonation?: boolean
    check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>
    /**
     * Accept an OAuth access token in place of a session: MCP clients on the MCP endpoint, and Consoles on other origins on
     * the Console data routes. See `verifyConsoleBearer()`.
     */
    oauth?: ConsoleOAuthConfig
    authBasePath?: (event: ConsoleRequestEvent) => Promise<string>
    signIn?: (event: ConsoleRequestEvent, denied?: Response) => Promise<Response>
    /** The page of `/_vitehub/sign-in` for a person who is signed in and may use the Console. */
    signedIn?: (event: ConsoleRequestEvent) => Promise<Response>
    user?: (event: ConsoleRequestEvent) => Promise<ConsoleUser | undefined>
  }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
  /**
   * The sections that this request may use. `"all"` when `console.authorize` is not set or returns `true`. An entry is a
   * section id, or `"<section>:read"` for a section that the request may only read.
   */
  readonly sections: "all" | readonly string[]
  /** The OAuth scopes of the access token; sessions have no scope limit. See `consoleScopesAllow()`. */
  readonly scopes?: readonly string[]
  readonly user?: ConsoleUser
  /** The verified OAuth token's login session, used only by Auth management. */
  readonly sessionId?: string
  /**
   * The bearer that the access check accepted: `"token"` for `VITEHUB_CONSOLE_TOKEN`, `"oauth"` for an OAuth access token.
   * Not set for a session, Cloudflare Access, or an open Console. Only a bearer call may come from another origin.
   */
  readonly via?: "oauth" | "token"
}

/**
 * The Console section that a guarded route belongs to.
 * - `section`: a section id, or a function that reads it from the request. A request outside the allowed sections gets `403`.
 * - `anySection: true`: the route serves every Console user, such as the section list and the RPC transport.
 * - `user: true`: read the signed-in user before the handler runs, so `access.user` is set.
 * - `write: true`: the route changes state, so a read-only grant (`"<section>:read"`) is refused.
 */
export type ConsoleRouteScope =
  | { section: ConsoleSectionId | ((event: ConsoleRequestEvent) => ConsoleSectionId | undefined), user?: boolean, write?: boolean }
  | { anySection: true, user?: boolean }

/** A Console server handler that runs only after `withConsoleAccess()` accepts the request. */
export type ConsoleGuardedHandler<TEvent, TResult> = (event: TEvent, access: ConsoleAccess) => TResult | Promise<TResult>

/** The route that `withConsoleAccess()` returns for a handler. Route files use it to type their default export. */
export type ConsoleAccessRoute<THandler extends (event: never, access: ConsoleAccess) => unknown> = (event: Parameters<THandler>[0]) => Promise<Awaited<ReturnType<THandler>> | Response>

const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
// Keyed by the Request of the Standard Context, so an H3 middleware and the Fetchable route of one request share it.
const checkedRequests = new WeakMap<Request, ConsoleAccess>()
const rejectedRequests = new WeakMap<Request, Response>()
const routeScopes = new WeakMap<object, ConsoleRouteScope>()
const deferredUsers = new WeakMap<ConsoleAccess, () => Promise<ConsoleUser | undefined>>()
// Responses that `console.authorize` returned, so a page visit gets them as they are.
const authorizeResponses = new WeakSet<Response>()

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

/** The app Auth mount used by the Console's own browser client. */
export function consoleAppAuthBasePath(event: ConsoleRequestEvent): Promise<string> | undefined {
  const policy = installedConsoleAccessPolicy()
  return policy && "authBasePath" in policy ? policy.authBasePath?.(event) : undefined
}

/**
 * Serve the built-in app Auth page at `/_vitehub/sign-in`. It is the login and consent page of MCP OAuth. A visit by a
 * signed-in person shows their access: the signed-in page, or the page of the rejection, such as the admin claim form.
 */
export function consoleAppSignIn(event: ConsoleRequestEvent): Promise<Response> | undefined {
  const policy = installedConsoleAccessPolicy()
  const url = consoleRequestURL(event)
  const signIn = policy && "signIn" in policy ? policy.signIn : undefined
  if (!signIn || url.pathname !== `${consoleMountBase(url.pathname)}/_vitehub/sign-in`) return undefined
  const method = getStandardContext(event).req.method.toUpperCase()
  // Better Auth's OAuth provider signs the query of its login and consent steps. Those steps go to the page as they are.
  if ((method !== "GET" && method !== "HEAD") || url.searchParams.has("sig")) return signIn(event)
  return (async () => {
    const access = await checkPageAccess(event)
    if (!isRuntimeResponse(access)) return policy && "signedIn" in policy && policy.signedIn ? policy.signedIn(event) : signIn(event)
    return access.status === 403 && !authorizeResponses.has(access) ? signIn(event, access) : signIn(event)
  })()
}

/** The access check of a visit to the sign-in page, once per request. */
async function checkPageAccess(event: ConsoleRequestEvent): Promise<ConsoleAccess | Response> {
  const request = consoleRequest(event)
  const access = checkedRequests.get(request) ?? rejectedRequests.get(request) ?? await checkConsoleAccess(event)
  if (isRuntimeResponse(access)) rejectedRequests.set(request, access)
  else checkedRequests.set(request, access)
  return access
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

function invalidConsoleBearer(bearer: Extract<ConsoleBearerResult, { ok: false }>): Response {
  const parameters = { description: "The access token is not valid.", error: "invalid_token" } as const
  return markBearerRejection(Response.json({ ...consoleDiagnosticBody("CONSOLE_SIGN_IN_REQUIRED", "The access token is not valid for this endpoint, or has expired."), ok: false, status: 401 }, {
    headers: { "cache-control": "no-store", "www-authenticate": bearer.audience === "mcp" ? mcpChallenge(bearer.state, parameters) : consoleChallenge(bearer.state, parameters), "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status: 401,
  }))
}

/** A `401` of a Console data route, with the challenge that names the Console resource metadata. */
async function consoleSignInRequired(oauth: ConsoleOAuthConfig, event: ConsoleRequestEvent, request: Request, response?: Response): Promise<Response> {
  const challenge = consoleChallenge(await resolveConsoleOAuth(oauth, event, request, isConsoleDevelopmentRuntime()))
  if (!response) {
    return Response.json({ ...consoleDiagnosticBody("CONSOLE_SIGN_IN_REQUIRED", "Sign in, or send an OAuth access token for the Console resource."), ok: false, status: 401 }, {
      headers: { "cache-control": "no-store", "www-authenticate": challenge, "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
      status: 401,
    })
  }
  if (response.headers.has("www-authenticate")) return response
  return withResponseHeaders(response, headers => headers.set("www-authenticate", challenge))
}

/**
 * Authenticate an OAuth access token at the app Auth middleware: on the MCP endpoint, and on the Console data routes.
 * Auth still checks its own matching route policies. Generated output registers it for each of these exact paths.
 */
export async function resolveConsoleAppAuthIdentity(request: Request, event: object, hasSession: boolean): Promise<ConsoleUser | Response | undefined> {
  const oauth = installedConsoleOAuth()
  if (!oauth) return undefined
  const mcp = new URL(request.url).pathname === oauth.path
  if (!mcp && !isConsoleDataPath(oauth, request)) return undefined
  // SAFETY: The Auth middleware supplies the original host event (or Web Request), as the OAuth Auth factory expects.
  const hostEvent = event as ConsoleRequestEvent
  const bearer = await verifyConsoleBearer(request, hostEvent, oauth, isConsoleDevelopmentRuntime())
  // The app Auth middleware answers before the Console route, so a Console on a listed origin needs the CORS headers here.
  if (bearer) return bearer.ok ? bearer.user : mcp ? invalidConsoleBearer(bearer) : withListedConsoleOrigin(invalidConsoleBearer(bearer), request)
  if (hasSession) return undefined
  if (!mcp) return withListedConsoleOrigin(await consoleSignInRequired(oauth, hostEvent, request), request)
  const state = await resolveConsoleOAuth(oauth, hostEvent, request, isConsoleDevelopmentRuntime())
  return Response.json({ code: "CONSOLE_SIGN_IN_REQUIRED", message: "Sign in to use the MCP endpoint.", fix: "Sign in with your MCP client. It starts the OAuth flow from the resource metadata." }, {
    headers: { "cache-control": "no-store", "www-authenticate": mcpChallenge(state), "x-content-type-options": "nosniff" },
    status: 401,
  })
}

/**
 * Whether the OAuth scopes of the access allow one call. A `read` call, or one that only reads, needs `vitehub:read`.
 * A `write` or `destructive` call needs `vitehub:write`. A session, the Console token, and other access without scopes
 * have no scope limit. `console.authorize` still decides the sections.
 */
export function consoleScopesAllow(access: ConsoleAccess, call: OperationCallKind): boolean {
  if (!access.scopes) return true
  return access.scopes.includes(call.kind === "read" || call.readOnly === true ? consoleMcpReadScope : consoleMcpWriteScope)
}

/** The `403` for a call that the OAuth scopes of the access token do not allow. */
export function consoleScopeRejection(call: OperationCallKind, name: string): Response {
  const scope = call.kind === "read" || call.readOnly === true ? consoleMcpReadScope : consoleMcpWriteScope
  return Response.json({ ...consoleDiagnosticBody("CONSOLE_ACCESS_DENIED", `The access token does not have the ${scope} scope, which ${name} needs.`), ok: false, status: 403 }, {
    headers: { "cache-control": "no-store", "www-authenticate": consoleChallenge(undefined, { error: "insufficient_scope", scope }), "x-content-type-options": "nosniff" },
    status: 403,
  })
}

async function checkConsoleAccess(event: ConsoleRequestEvent, options: { user?: boolean } = {}): Promise<ConsoleAccess | Response> {
  const policy = installedConsoleAccessPolicy()
  if (!policy) return rejection(500, "CONSOLE_ACCESS_NOT_CONFIGURED", "Console access is not configured. The generated Console output did not install an access policy.")
  // Every Console route, page, Realtime room, and page tool reads its access here, so none can skip this rule.
  if (!await isConsoleLoopbackRequest(consoleRequest(event), { access: policy.mode, remoteAddress: getStandardContext(event).runtime?.clientAddress })) {
    return rejection(403, "CONSOLE_LOOPBACK_ONLY")
  }
  let user: ConsoleUser | undefined
  let scopes: readonly string[] | undefined
  let sessionId: string | undefined
  let via: ConsoleAccess["via"]
  if (policy.mode === "local") {
    if (!isConsoleDevelopmentRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  }
  else if (policy.mode === "open") {
    // open access intentionally performs no authentication
  }
  else if (policy.mode === "token") {
    // The token is the only way in. A cookie or a session never counts.
    const token = await checkConsoleToken(consoleRequest(event), event)
    if (!token.ok) return token.response
    via = "token"
  }
  else {
    const bearer = policy.mode === "auth" && policy.oauth ? await verifyConsoleBearer(consoleRequest(event), event, policy.oauth, isConsoleDevelopmentRuntime()) : undefined
    // A token that fails is a rejection, not a fall back to the session: the client has to sign in again.
    if (bearer && !bearer.ok) {
      return invalidConsoleBearer(bearer)
    }
    if (bearer) {
      // A valid access token is the sign-in. `authorize` still decides the sections, and the scopes limit the calls.
      user = bearer.user
      scopes = bearer.scopes
      sessionId = bearer.sessionId
      via = "oauth"
      if (policy.oauth?.authorize) {
        const allowed = await policy.oauth.authorize({ request: consoleRequest(event), user })
        if (isRuntimeResponse(allowed)) return allowed
        if (allowed !== true) return rejection(403, "CONSOLE_ACCESS_DENIED")
      }
    }
    else {
      if (!policy.check) {
        return rejection(500, "CONSOLE_AUTH_NOT_CONFIGURED", policy.mode === "auth"
          ? "console: { auth: \"app\" } requires a discovered ViteHub Auth Definition."
          : "Cloudflare Access Console Auth is not configured.")
      }
      const response = await policy.check(event)
      // A Console on another origin reads the challenge to find where to get a token.
      if (response?.status === 401 && policy.oauth && isConsoleDataPath(policy.oauth, consoleRequest(event))) return consoleSignInRequired(policy.oauth, event, consoleRequest(event), response)
      if (response) return response
      if (policy.user && (options.user || policy.authorize)) user = await policy.user(event)
    }
  }
  let sections: ConsoleAccess["sections"] = "all"
  if (policy.mode !== "local" && policy.authorize) {
    const request = consoleRequest(event)
    const result: unknown = await policy.authorize(policy.mode === "token" ? { request, via: "token" } : user ? { request, user } : { request })
    if (isRuntimeResponse(result)) {
      authorizeResponses.add(result)
      return result
    }
    if (result === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    if (result !== true) {
      const allowed = consoleAuthorizedSections(result)
      if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED", "console.authorize must return true, false, a Response, or { sections: string[] }.")
      if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
      sections = allowed
    }
  }
  const access = consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections, ...(scopes ? { scopes } : {}), ...(user ? { user } : {}), ...(sessionId ? { sessionId } : {}), ...(via ? { via } : {}) })
  if (policy.mode === "auth" && !user && policy.user) {
    // Read the user once per access, however many handlers ask for it.
    let pending: Promise<ConsoleUser | undefined> | undefined
    deferredUsers.set(access, () => pending ??= policy.user!(event))
  }
  return access
}

export async function readConsoleAccessUser(access: ConsoleAccess): Promise<ConsoleUser | undefined> {
  if (!consoleAccessGrant.isValid(access)) return undefined
  return access.user ?? await deferredUsers.get(access)?.()
}

/** The OAuth settings of the installed policy, or undefined when the Console does not accept access tokens. */
export function installedConsoleOAuth(): ConsoleOAuthConfig | undefined {
  const policy = installedConsoleAccessPolicy()
  return policy && policy.mode === "auth" ? policy.oauth : undefined
}

/**
 * The user that an operation sees. A development server without sign-in (`local` access, or `open` with
 * `console.auth: false`) has no accounts, so the person is the local developer: `{ id: "local", name: "You" }`.
 * Production servers never invent a user.
 */
export async function readConsoleOperationUser(access: ConsoleAccess): Promise<ConsoleUser | undefined> {
  const user = await readConsoleAccessUser(access)
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

/** Whether the access may read or write by its OAuth scopes. A session or a Console token has no scope limit. */
export function consoleAccessHasScope(access: ConsoleAccess, kind: "read" | "write"): boolean {
  return !access.scopes || access.scopes.includes(kind === "read" ? consoleMcpReadScope : consoleMcpWriteScope)
}

/** The OAuth scope that an operation call needs: `vitehub:read` to read, `vitehub:write` to change state. */
export function consoleOperationScope(operation: Pick<AnyOperation, "kind">): string {
  return operation.kind === "read" ? consoleMcpReadScope : consoleMcpWriteScope
}

/**
 * Whether the section grants of the access allow the kind of the operation, for a list of what it may call. An operation
 * with `readOnlyWhen` shows with a read-only grant, because some of its calls only read. Each call checks again.
 */
export function consoleOperationGranted(access: ConsoleAccess, operation: AnyOperation): boolean {
  return operationListed(access, operation, operation.readOnlyWhen ? undefined : operation)
}

/** Whether section grants and OAuth scopes offer calls of the operation. Each call checks its own kind again. */
export function consoleOperationOffered(access: ConsoleAccess, operation: AnyOperation): boolean {
  return consoleOperationGranted(access, operation) && (
    !access.scopes || access.scopes.includes(consoleOperationScope(operation))
    || (operation.readOnlyWhen !== undefined && access.scopes.includes(consoleMcpReadScope))
  )
}

export function allowedConsoleSections(access: ConsoleAccess, available: readonly ConsoleSectionId[]): ConsoleSectionId[] {
  return available.filter(section => consoleAccessAllows(access, section))
}

/**
 * Name the manager of one Connections management request with the installed Console access policy.
 * The generated Connections actor module calls it, so Connections routes and Console data routes share one policy.
 * - `auth`: `sessionActor` reads the signed-in user as `user:<id>`.
 * - `open` has no user id and retains the former host-managed actor identity so
 *   persisted Connections authorization state remains usable across upgrades.
 * - `local` and `cloudflare-access` have no user id. The manager is `user:<mode>`.
 * Returns the policy rejection when the policy rejects the request, so the Connections handler returns the same
 * Console diagnostic. Returns `403` with `CONSOLE_MANAGER_REQUIRED` when an `auth` session has no user id.
 */
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

export async function consoleConnectionsActor(
  event: ConsoleRequestEvent | Request,
  sessionActor?: () => Promise<string | undefined>,
): Promise<string | Response> {
  const context = event instanceof Request ? { "~standard": getStandardContext(event) } : event
  const access = await checkConsoleAccess(context, { user: true })
  if (isRuntimeResponse(access)) return access
  if (!consoleAccessAllows(access, "connections")) return rejection(403, "CONSOLE_ACCESS_DENIED")
  if (access.mode === "auth") {
    const actor = sessionActor ? await sessionActor() : (await readConsoleAccessUser(access))?.id
    return actor ? (actor.startsWith("user:") ? actor : `user:${actor}`) : rejection(403, "CONSOLE_MANAGER_REQUIRED")
  }
  // `open` replaces the removed host-managed policy. Keep its actor stable so
  // an authorization started before an upgrade can still complete afterwards.
  return access.mode === "open" ? "user:host-managed" : `user:${access.mode}`
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
  /** The signed-in Console user, a Cloudflare Access email, or a guest of an open Console. Null without Console access. */
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
      pending = checkConsoleAccess(consoleEvent, { user: true }).then(result => isRuntimeResponse(result) || !consoleAccessAllows(result, section) ? undefined : result)
      checked.set(event, pending)
    }
    return pending
  }
  return {
    async identify({ event }) {
      const allowed = await access(event)
      if (!allowed) return null
      const user = await readConsoleAccessUser(allowed)
      const id = text(user?.id) ?? text(user?.email)
      if (user && id) {
        const person: ConsoleRealtimeUser = { id }
        const name = text(user.name) ?? text(user.email)
        if (name) person.name = name
        if (text(user.email)) person.email = text(user.email)
        if (text(user.image)) person.image = text(user.image)
        return person
      }
      // Cloudflare Access names the person in a header after it checked the token.
      const email = allowed.mode === "cloudflare-access" ? text(consoleRequest(event as ConsoleRequestEvent).headers.get("cf-access-authenticated-user-email")) : undefined
      if (email) return { id: email, email, name: email }
      // An open Console has no accounts: each connection is a guest.
      return { id: `guest-${crypto.randomUUID()}`, name: "Guest" }
    },
    async authorize({ event, kind }) {
      const allowed = await access(event)
      return Boolean(allowed && (kind !== "write" || consoleAccessWrites(allowed, section)))
    },
    async user({ event }) {
      const allowed = await access(event)
      return allowed ? await readConsoleAccessUser(allowed) ?? null : null
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
      const checked = await checkConsoleAccess(event, { user: declared.user === true })
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
      // Routes that change state need write scope. Mixed routes, such as Auth management, check each parsed action.
      if (declared.write === true && !consoleScopesAllow(access, { kind: "write" })) return consoleScopeRejection({ kind: "write" }, `the ${section} section`)
    }
    // A bound RPC grant may defer its user until a legacy handler asks for it.
    if (declared.user === true && !access.user) {
      const user = await readConsoleAccessUser(access)
      if (user) {
        access = consoleAccessGrant.issue(access.mode, { ...access, user })
        checkedRequests.set(request, access)
      }
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
    const request = new Request("http://vitehub.local/_vitehub/rpc/__call", { method: "POST" })
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
