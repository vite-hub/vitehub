import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleRequestError, consoleRequestURL, type ConsoleRequestEvent } from "./request.ts"

import type { ConsoleAuthorize, ConsoleUser } from "../../auth.ts"
import type { AgentActor } from "@vite-hub/agent"
import type { ConsoleSectionId } from "../sections.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `local`: the development server, for `console: true` and development without an edge.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * - `host-managed`: the host-supplied `console.authorize` function.
 */
export type ConsoleAccessPolicy =
  | { mode: "open", authorize?: ConsoleAuthorize }
  | { mode: "local" }
  | { mode: "auth" | "cloudflare-access", authorize?: ConsoleAuthorize, check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>, user?: (event: ConsoleRequestEvent) => Promise<ConsoleUser | undefined> }
  | { mode: "host-managed", authorize?: ConsoleAuthorize }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
  readonly sections?: "all" | readonly ConsoleSectionId[]
  readonly user?: ConsoleUser
}

export type ConsoleRouteScope =
  | { section: ConsoleSectionId | ((event: ConsoleRequestEvent) => ConsoleSectionId | undefined) }
  | { anySection: true }

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
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "host-managed", "local", "open"])

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
  if ("check" in policy && policy.check !== undefined && !(policy.check instanceof Function)) {
    throw new TypeError("[vitehub] Console access check must be a function.")
  }
  if ("authorize" in policy && policy.authorize !== undefined && !(policy.authorize instanceof Function)) {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  if ("user" in policy && policy.user !== undefined && !(policy.user instanceof Function)) {
    throw new TypeError("[vitehub] Console access user reader must be a function.")
  }
  if (policy.mode === "open" && !policy.authorize && productionRuntime() && !scope[openWarningKey]) {
    scope[openWarningKey] = true
    globalThis.console?.warn(consoleOpenAccessWarning)
  }
  scope[policyKey] = Object.freeze({ ...policy })
}

function productionRuntime(): boolean {
  return globalThis.process?.env?.NODE_ENV === "production"
}

/** Build the standard Fetch request passed to Console authorization and runtime contexts. */
export function consoleRequest(event: ConsoleRequestEvent): Request {
  if (event.req instanceof Request) return event.req
  const headers = new Headers()
  const copyHeaders = (source: unknown, overwrite = true): void => {
    const setHeader = (name: string, value: string): void => {
      if (overwrite || !headers.has(name)) headers.set(name, value)
    }
    if (source instanceof Headers) {
      source.forEach((value, name) => setHeader(name, value))
      return
    }
    if (source instanceof Object && "get" in source && source.get instanceof Function) {
      for (const name of ["accept", "authorization", "cookie", "content-type", "host", "origin", "user-agent", "x-forwarded-host", "x-forwarded-proto"]) {
        const value = source.get(name)
        if (typeof value === "string") setHeader(name, value)
      }
    }
    if (!(source instanceof Object)) return
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

function isSectionId(value: unknown): value is ConsoleSectionId {
  return typeof value === "string" && value.length > 0
}

function authorizedSections(result: unknown): readonly ConsoleSectionId[] | undefined {
  if (!(result instanceof Object)) return
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
    if (section instanceof Function || (typeof section === "string" && section.length > 0)) return
  }
  if ("anySection" in routeScope && routeScope.anySection === true) return
  throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
}

async function checkConsoleAccess(event: ConsoleRequestEvent, options: { user?: boolean } = {}): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "CONSOLE_ACCESS_NOT_CONFIGURED", "Console access is not configured. The generated Console output did not install an access policy.")
  let user: ConsoleUser | undefined
  let authorization: unknown = true
  if (policy.mode === "local") {
    if (productionRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  }
  else if (policy.mode === "open") {
    // open access intentionally performs no authentication
  }
  else if (policy.mode === "host-managed") {
    if (!policy.authorize) {
      return rejection(500, "CONSOLE_AUTHORIZE_REQUIRED")
    }
    const result = await policy.authorize({ request: consoleRequest(event) })
    if (result instanceof Response) return result
    authorization = result
  }
  else {
    if (!policy.check) {
      return rejection(500, "CONSOLE_AUTH_NOT_CONFIGURED", policy.mode === "auth"
        ? "console: { access: \"auth\" } requires a discovered ViteHub Auth Definition."
        : "Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) return response
    if (policy.user && (options.user || policy.authorize)) user = await policy.user(event)
  }
  let sections: ConsoleAccess["sections"]
  if (policy.mode !== "host-managed" && policy.mode !== "local" && policy.authorize) {
    const result: unknown = await policy.authorize(user ? { request: consoleRequest(event), user } : { request: consoleRequest(event) })
    if (result instanceof Response) return result
    if (result === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    if (result !== true) {
      const allowed = authorizedSections(result)
      if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED", "console.authorize must return true, false, a Response, or { sections: string[] }.")
      if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
      sections = allowed
    }
  }
  else if (authorization !== true) {
    if (authorization === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    const allowed = authorizedSections(authorization)
    if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED", "console.authorize must return true, false, a Response, or { sections: string[] }.")
    if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
    sections = allowed
  }
  const access = consoleAccessGrant.issue(policy.mode, { mode: policy.mode, ...(sections ? { sections } : {}), ...(user ? { user } : {}) })
  if (policy.mode === "auth" && !user && policy.user) deferredUsers.set(access, () => policy.user!(event))
  return access
}

export async function readConsoleAccessUser(access: ConsoleAccess): Promise<ConsoleUser | undefined> {
  if (!consoleAccessGrant.isValid(access)) return undefined
  return access.user ?? await deferredUsers.get(access)?.()
}

export function consoleAccessAllows(access: ConsoleAccess, section: ConsoleSectionId | undefined): boolean {
  if (!consoleAccessGrant.isValid(access)) return false
  return access.sections === undefined || access.sections === "all" || (section !== undefined && access.sections.includes(section))
}

export function allowedConsoleSections(access: ConsoleAccess, available: readonly ConsoleSectionId[]): ConsoleSectionId[] {
  return available.filter(section => consoleAccessAllows(access, section))
}

/**
 * Name the manager of one Connections management request with the installed Console access policy.
 * The generated Connections actor module calls it, so Connections routes and Console data routes share one policy.
 * - `auth`: `sessionActor` reads the signed-in user as `user:<id>`.
 * - `local`, `host-managed`, and `cloudflare-access` have no user id. The manager is `user:<mode>`.
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
  if (access instanceof Response) return access
  if (!consoleAccessAllows(access, "connections")) return rejection(403, "CONSOLE_ACCESS_DENIED")
  if (access.mode === "auth") {
    const actor = sessionActor ? await sessionActor() : (await readConsoleAccessUser(access))?.id
    return actor ? (actor.startsWith("user:") ? actor : `user:${actor}`) : rejection(403, "CONSOLE_MANAGER_REQUIRED")
  }
  return `user:${access.mode}`
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request.
 * Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
  routeScope: ConsoleRouteScope = { anySection: true },
): (event: TEvent) => Promise<TResult | Response> {
  if (!(handler instanceof Function)) throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  assertRouteScope(routeScope)
  const declared = Object.freeze({ ...routeScope }) as ConsoleRouteScope
  const route = async (event: TEvent) => {
    let access = checkedEvents.get(event)
    if (!access || !consoleAccessGrant.isValid(access)) {
      const checked = await checkConsoleAccess(event)
      if (checked instanceof Response) return checked
      access = checked
      checkedEvents.set(event, access)
    }
    if ("section" in declared) {
      const section = declared.section instanceof Function ? declared.section(event) : declared.section
      // A dynamic scope that cannot resolve to a section is not an unrestricted route.
      if (section === undefined || !consoleAccessAllows(access, section)) return rejection(403, "CONSOLE_ACCESS_DENIED")
    }
    return handler(event, access)
  }
  routeScopes.set(route, declared)
  return route
}

export function consoleRouteScope(route: unknown): ConsoleRouteScope | undefined {
  return route instanceof Function ? routeScopes.get(route) : undefined
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
