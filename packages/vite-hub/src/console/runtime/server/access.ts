import { installOperationSectionResolver, operationAccessAllows } from "@vite-hub/internal/operations"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleMountBase } from "../console-route.ts"
import { consoleDiagnosticBody, isConsoleImpersonationRejection, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { markBearerRejection, mcpChallenge, resolveConsoleOAuth, verifyConsoleBearer, type ConsoleOAuthConfig, type ConsoleOAuthState } from "./bearer.ts"
import { consoleRequestError, consoleRequestURL, isConsoleDevelopmentRuntime, type ConsoleRequestEvent } from "./request.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleAuthorize, ConsoleUser } from "../../auth.ts"
import type { AgentActor } from "@vite-hub/agent"
import type { ConsoleSectionId } from "../sections.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `open`: no sign-in. `authorize` runs when it is set.
 * - `local`: the development server only. Production requests fail closed.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * `impersonation: true` is `console.impersonation`. The Auth section can then start and stop impersonation.
 */
export type ConsoleAccessPolicy =
  | { mode: "open", authorize?: ConsoleAuthorize, impersonation?: boolean, signInPage?: string }
  | { mode: "local" }
  | {
    mode: "auth" | "cloudflare-access"
    authorize?: ConsoleAuthorize
    impersonation?: boolean
    check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>
    /** Accept an OAuth access token, as MCP clients send it, in place of a session. See `verifyConsoleBearer()`. */
    oauth?: ConsoleOAuthConfig
    signInPage?: string
    authBasePath?: (event: object) => Promise<string>
    signIn?: (event: object, denied?: Response) => Promise<Response>
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
  /** The OAuth scopes of the access token; sessions have no scope limit. */
  readonly scopes?: readonly string[]
  readonly user?: ConsoleUser
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

const policyKey: unique symbol = Symbol.for("vitehub.console.access")
const openWarningKey: unique symbol = Symbol.for("vitehub.console.access.open-warning")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy, [openWarningKey]?: true }
const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
const checkedEvents = new WeakMap<object, ConsoleAccess>()
const routeScopes = new WeakMap<object, ConsoleRouteScope>()
const deferredUsers = new WeakMap<ConsoleAccess, () => Promise<ConsoleUser | undefined>>()
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "local", "open"])

export const consoleOpenAccessWarning = "[vitehub] console: { auth: false } has no sign-in. Anyone who can reach /_vitehub can use the Console. Set console.auth to \"app\" or a Console Auth config, or set console.authorize."

/** A JSON rejection with the Console diagnostic fields: `code`, `message` (the why), `fix`, and `docs`. */
function rejection(status: number, code: ConsoleDiagnosticCode, message?: string): Response {
  return Response.json({ ...consoleDiagnosticBody(code, message), ok: false, status }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status,
  })
}

/** Install the Console access policy. Generated Console output calls this before it serves a request. */
export function installConsoleAccess(policy: ConsoleAccessPolicy): void {
  if (!(policy instanceof Object) || !modes.has(policy.mode)) {
    throw new TypeError("[vitehub] Console access requires a known access mode.")
  }
  if ("check" in policy && policy.check !== undefined && typeof policy.check !== "function") {
    throw new TypeError("[vitehub] Console access check must be a function.")
  }
  if ("authorize" in policy && policy.authorize !== undefined && typeof policy.authorize !== "function") {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  if ("user" in policy && policy.user !== undefined && typeof policy.user !== "function") {
    throw new TypeError("[vitehub] Console access user reader must be a function.")
  }
  if ("signInPage" in policy && policy.signInPage !== undefined && !isConsoleSignInPage(policy.signInPage)) {
    throw new TypeError("[vitehub] The Console sign-in page must be a path on the same origin, such as /sign-in.")
  }
  if ("impersonation" in policy && policy.impersonation !== undefined && typeof policy.impersonation !== "boolean") {
    throw new TypeError("[vitehub] console.impersonation must be true or false.")
  }
  if (policy.mode === "open" && !policy.authorize && !isConsoleDevelopmentRuntime() && !scope[openWarningKey]) {
    scope[openWarningKey] = true
    globalThis.console?.warn(consoleOpenAccessWarning)
  }
  scope[policyKey] = Object.freeze({ ...policy })
  installOperationSectionResolver(async ({ user }) => {
    if (policy.mode === "local" || !policy.authorize) return "all"
    // Agents have no browser request, so `authorize` gets one without headers and the user that the Actor stands for.
    const request = new Request("http://vitehub.local/_vitehub/rpc/__call", { method: "POST" })
    const result: unknown = await policy.authorize(user ? { request, user: user as ConsoleUser } : { request })
    if (result === true) return "all"
    return isRuntimeResponse(result) ? [] : authorizedSections(result) ?? []
  })
}

/** Whether a value stays a path on the same origin after URL normalization. */
export function isConsoleSignInPage(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The value comes from configuration or generated output.
  if (typeof value !== "string" || !/^\/(?!\/)[^\\\s]*$/.test(value)) return false
  // Dot segments can turn a single-slash input into a network-path reference when serialized.
  return !new URL(value, "http://vitehub.local").pathname.startsWith("//")
}

/** The sign-in page of the installed policy, under the application mount of a Console path. */
export function consoleSignInPage(pathname: string): string | undefined {
  const policy = scope[policyKey]
  const page = policy && "signInPage" in policy ? policy.signInPage : undefined
  if (!page) return undefined
  const normalized = new URL(page, "http://vitehub.local")
  const mounted = `${consoleMountBase(pathname)}${normalized.pathname}${normalized.search}${normalized.hash}`
  return isConsoleSignInPage(mounted) ? mounted : undefined
}

/** Whether `console.impersonation` is on. Without it, the Console has no impersonation route or action. */
export function consoleImpersonation(): boolean {
  const policy = scope[policyKey]
  return Boolean(policy && "impersonation" in policy && policy.impersonation === true)
}

/** The app Auth mount used by the Console's own browser client. */
export function consoleAppAuthBasePath(event: ConsoleRequestEvent): Promise<string> | undefined {
  const policy = scope[policyKey]
  return policy && "authBasePath" in policy ? policy.authBasePath?.(event) : undefined
}

/** Serve the built-in app Auth page before the application's protected Console routes. */
export function consoleAppSignIn(event: ConsoleRequestEvent): Promise<Response> | undefined {
  const policy = scope[policyKey]
  const url = consoleRequestURL(event)
  if (policy && "signIn" in policy && policy.signIn && url.pathname === `${consoleMountBase(url.pathname)}/_vitehub/sign-in`) {
    return policy.signIn(event)
  }
}

/**
 * Send a signed-out visit to a Console page to the sign-in page of the installed policy. The `redirect` query parameter
 * is the Console page that the visitor asked for. Returns `undefined` when the policy has no sign-in page, the request
 * does not read a page, or the access check does not answer `401`.
 */
export async function consoleSignInRedirect(event: ConsoleRequestEvent): Promise<Response | undefined> {
  const url = consoleRequestURL(event)
  const page = consoleSignInPage(url.pathname)
  const method = (event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET").toUpperCase()
  if (!page || (method !== "GET" && method !== "HEAD")) return undefined
  const access = checkedEvents.get(event) ?? await checkConsoleAccess(event)
  if (!isRuntimeResponse(access)) {
    checkedEvents.set(event, access)
    return undefined
  }
  const policy = scope[policyKey]
  // An impersonation session gets the page that leads back to the administrator's session, whatever the sign-in page.
  if (access.status === 403 && policy && "signIn" in policy && policy.signIn && (page.endsWith("/_vitehub/sign-in") || await isConsoleImpersonationRejection(access))) {
    return policy.signIn(event, access)
  }
  if (access.status !== 401) return undefined
  const target = new URL(page, url)
  target.searchParams.set("redirect", `${url.pathname}${url.search}`)
  return new Response(null, {
    headers: { "cache-control": "no-store", location: `${target.pathname}${target.search}${target.hash}`, "x-robots-tag": "noindex, nofollow" },
    status: 302,
  })
}

/** Build the standard Fetch request passed to Console authorization and runtime contexts. */
export function consoleRequest(event: ConsoleRequestEvent): Request {
  if (isRequestLike(event.req)) return event.req
  const headers = new Headers()
  const copyHeaders = (source: unknown, overwrite = true): void => {
    const setHeader = (name: string, value: string): void => {
      if (overwrite || !headers.has(name)) headers.set(name, value)
    }
    if (source instanceof Headers) {
      source.forEach((value, name) => setHeader(name, value))
      return
    }
    if (source !== null && typeof source === "object" && "get" in source && typeof source.get === "function") {
      for (const name of ["accept", "authorization", "cookie", "content-type", "host", "origin", "user-agent", "x-forwarded-host", "x-forwarded-proto"]) {
        const value = source.get(name)
        if (typeof value === "string") setHeader(name, value)
      }
      return
    }
    if (source === null || typeof source !== "object") return
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) setHeader(name, Array.isArray(value) ? value.join(", ") : String(value))
    }
  }
  // Match consoleRequestURL(): request headers take precedence per header,
  // followed by event-level and Node request headers as fallbacks.
  copyHeaders(event.node?.req?.headers)
  copyHeaders(event.headers)
  copyHeaders(event.req?.headers, true)
  return new Request(consoleRequestURL(event), { headers, method: event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET" })
}

function isRequestLike(value: unknown): value is Request {
  if (value === null || typeof value !== "object") return false
  try {
    const request = value as Record<string, unknown>
    const headers = request.headers
    return typeof request.method === "string"
      && typeof request.url === "string"
      && headers !== null
      && typeof headers === "object"
      && typeof (headers as { get?: unknown }).get === "function"
      && ["clone", "arrayBuffer", "blob", "formData", "json", "text"].every(method => typeof request[method] === "function")
      && "body" in request && "bodyUsed" in request && "signal" in request
  }
  catch { return false }
}

const nativeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get

/**
 * Return whether `value` is a Response of this runtime.
 * The native `status` getter checks the internal Response slot, so a proxy, a copied prototype, an object tagged `Response`,
 * and a Response from another Fetch implementation all fail. The check reads no property of `value`.
 */
function isRuntimeResponse(value: unknown): value is Response {
  if (!nativeResponseStatus || value === null || typeof value !== "object") return false
  try {
    Reflect.apply(nativeResponseStatus, value, [])
    return true
  }
  catch {
    return false
  }
}

function isSectionId(value: unknown): value is ConsoleSectionId {
  return typeof value === "string" && value.length > 0
}

function authorizedSections(result: unknown): readonly ConsoleSectionId[] | undefined {
  // A section result from another JavaScript realm fails `instanceof Object`.
  if (result === null || typeof result !== "object") return
  const sectionsValue = Reflect.get(result, "sections")
  if (!Array.isArray(sectionsValue)) return
  const sections: unknown[] = sectionsValue
  if (!sections.every(isSectionId)) return
  return Object.freeze([...new Set(sections)])
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

function invalidConsoleBearer(state: ConsoleOAuthState): Response {
  return markBearerRejection(Response.json({ ...consoleDiagnosticBody("CONSOLE_SIGN_IN_REQUIRED", "The access token is not valid for this endpoint, or has expired."), ok: false, status: 401 }, {
    headers: { "cache-control": "no-store", "www-authenticate": mcpChallenge(state, { description: "The access token is not valid.", error: "invalid_token" }), "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status: 401,
  }))
}

/** Authenticate MCP at the app Auth middleware; Auth still checks its own matching route policies. */
export async function resolveConsoleAppAuthIdentity(request: Request, event: object, hasSession: boolean): Promise<ConsoleUser | Response | undefined> {
  const oauth = installedConsoleOAuth()
  if (!oauth || new URL(request.url).pathname !== oauth.path) return undefined
  // SAFETY: The Auth middleware supplies the original host event (or Web Request), as the OAuth Auth factory expects.
  const hostEvent = event as ConsoleRequestEvent
  const bearer = await verifyConsoleBearer(request, hostEvent, oauth, isConsoleDevelopmentRuntime())
  if (bearer) return bearer.ok ? bearer.user : invalidConsoleBearer(bearer.state)
  if (hasSession) return undefined
  const state = await resolveConsoleOAuth(oauth, hostEvent, request, isConsoleDevelopmentRuntime())
  return Response.json({ code: "CONSOLE_SIGN_IN_REQUIRED", message: "Sign in to use the MCP endpoint.", fix: "Sign in with your MCP client. It starts the OAuth flow from the resource metadata." }, {
    headers: { "cache-control": "no-store", "www-authenticate": mcpChallenge(state), "x-content-type-options": "nosniff" },
    status: 401,
  })
}

async function checkConsoleAccess(event: ConsoleRequestEvent, options: { user?: boolean } = {}): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "CONSOLE_ACCESS_NOT_CONFIGURED", "Console access is not configured. The generated Console output did not install an access policy.")
  let user: ConsoleUser | undefined
  let scopes: readonly string[] | undefined
  if (policy.mode === "local") {
    if (!isConsoleDevelopmentRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  }
  else if (policy.mode === "open") {
    // open access intentionally performs no authentication
  }
  else {
    const bearer = policy.mode === "auth" && policy.oauth ? await verifyConsoleBearer(consoleRequest(event), event, policy.oauth, isConsoleDevelopmentRuntime()) : undefined
    // A token that fails is a rejection, not a fall back to the session: the client has to sign in again.
    if (bearer && !bearer.ok) {
      return invalidConsoleBearer(bearer.state)
    }
    if (bearer) {
      // A valid access token is the sign-in. `authorize` still decides the sections, and the scopes limit the tools.
      user = bearer.user
      scopes = bearer.scopes
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
      if (response) return response
      if (policy.user && (options.user || policy.authorize)) user = await policy.user(event)
    }
  }
  let sections: ConsoleAccess["sections"] = "all"
  if (policy.mode !== "local" && policy.authorize) {
    const result: unknown = await policy.authorize(user ? { request: consoleRequest(event), user } : { request: consoleRequest(event) })
    if (isRuntimeResponse(result)) return result
    if (result === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    if (result !== true) {
      const allowed = authorizedSections(result)
      if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED", "console.authorize must return true, false, a Response, or { sections: string[] }.")
      if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
      sections = allowed
    }
  }
  const access = consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections, ...(scopes ? { scopes } : {}), ...(user ? { user } : {}) })
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
  const policy = scope[policyKey]
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
/** Map the verified Console user to the Agent Actor used by invocations and replay. */
export function consoleAccessActor(user: ConsoleUser | undefined): AgentActor | undefined {
  if (!user?.id) return undefined
  const label = "email" in user && typeof user.email === "string" && user.email
    ? user.email
    : "name" in user && typeof user.name === "string" && user.name
      ? user.name
      : user.id
  return { id: user.id, kind: "authUser", label, meta: { authUserId: user.id } }
}

export async function consoleConnectionsActor(
  event: ConsoleRequestEvent,
  sessionActor?: () => Promise<string | undefined>,
): Promise<string | Response> {
  const access = await checkConsoleAccess(event, { user: true })
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
 * Whether the installed access policy lets this request open the Console, for at least one section. The `console` page
 * tool uses it, so a page shows the Console link only to people that the Console accepts.
 */
export async function consoleAllowsRequest(event: unknown): Promise<boolean> {
  if (!(event instanceof Object)) return false
  // SAFETY: the page tools session passes the H3 event of its Nitro route, which has the members the check reads.
  return !isRuntimeResponse(await checkConsoleAccess(event as ConsoleRequestEvent))
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request.
 * Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
  routeScope: ConsoleRouteScope,
): (event: TEvent) => Promise<TResult | Response> {
  if (typeof handler !== "function") throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  assertRouteScope(routeScope)
  const declared = Object.freeze({ ...routeScope }) as ConsoleRouteScope
  const route = async (event: TEvent) => {
    let access = checkedEvents.get(event)
    if (!access || !consoleAccessGrant.isValid(access)) {
      const checked = await checkConsoleAccess(event, { user: declared.user === true })
      // A Response from another realm fails `instanceof`. It is a denial, not an access grant.
      if (isRuntimeResponse(checked)) return checked
      access = checked
      checkedEvents.set(event, access)
    }
    if ("section" in declared) {
      const section = typeof declared.section === "function" ? declared.section(event) : declared.section
      // A dynamic scope that cannot resolve to a section is not an unrestricted route.
      if (section === undefined || !consoleAccessAllows(access, section)) return rejection(403, "CONSOLE_ACCESS_DENIED")
      if (declared.write === true && !consoleAccessWrites(access, section)) return rejection(403, "CONSOLE_ACCESS_DENIED")
    }
    // A bound RPC grant may defer its user until a legacy handler asks for it.
    if (declared.user === true && !access.user) {
      const user = await readConsoleAccessUser(access)
      if (user) {
        access = consoleAccessGrant.issue(access.mode, { ...access, user })
        checkedEvents.set(event, access)
      }
    }
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
  const policy = scope[policyKey]
  if (!policy || context.surface !== "agent" || context.access.mode !== "agent") {
    throw consoleRequestError(403, "This Console access was not created by the access check.")
  }
  let allowed: ConsoleAccess["sections"] = "all"
  if (policy.mode !== "local" && policy.authorize) {
    const request = new Request("http://vitehub.local/_vitehub/rpc/__call", { method: "POST" })
    const result = await policy.authorize({ request, ...(context.user ? { user: context.user } : {}) })
    if (result !== true) {
      const sections = authorizedSections(result)
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
 * Bind a checked Console access to an internal event, such as one Console RPC operation.
 * A guarded handler that receives this event uses the bound access. Rejects an access that `withConsoleAccess()` did not create.
 */
export function bindConsoleAccess<TEvent extends ConsoleRequestEvent>(access: ConsoleAccess, event: TEvent): TEvent {
  if (!consoleAccessGrant.isValid(access)) throw consoleRequestError(403, "This Console access was not created by the access check.")
  if (checkedEvents.has(event)) throw consoleRequestError(500, "Console access is already bound to this request.")
  checkedEvents.set(event, access)
  return event
}
