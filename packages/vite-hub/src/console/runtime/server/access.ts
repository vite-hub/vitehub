import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleRequestError, consoleRequestURL, type ConsoleHeaders, type ConsoleRequestEvent } from "./request.ts"

import type { ConsoleAuthorize, ConsoleUser } from "../../auth.ts"
import type { AgentActor } from "@vite-hub/agent"
import type { ConsoleSectionId } from "../sections.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `open`: `console: { auth: false }`. No sign-in.
 * - `auth`: a ViteHub Auth Session, from `auth: "app"` or a session-based Console Auth. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 *
 * `authorize` is the `console.authorize` function. It runs after the mode check and can limit the allowed sections.
 */
export type ConsoleAccessPolicy =
  | { mode: "open", authorize?: ConsoleAuthorize }
  | {
    mode: "auth" | "cloudflare-access"
    authorize?: ConsoleAuthorize
    check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>
    /** Read the signed-in user for `authorize` and for Connections activity. */
    user?: (event: ConsoleRequestEvent) => Promise<ConsoleUser | undefined>
  }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
  /** The sections that this request may use. `"all"` when `console.authorize` is not set or returns `true`. */
  readonly sections: "all" | readonly ConsoleSectionId[]
  /** The signed-in user, when the policy read it. */
  readonly user?: ConsoleUser
}

/**
 * The Console section that a guarded route belongs to.
 * - `section`: a section id, or a function that reads it from the request. A request outside the allowed sections gets `403`.
 * - `anySection: true`: the route serves every Console user, such as the section list and the RPC transport.
 */
export type ConsoleRouteScope =
  | { section: ConsoleSectionId | ((event: ConsoleRequestEvent) => ConsoleSectionId | undefined), user?: boolean }
  | { anySection: true, user?: boolean }

/** A Console server handler that runs only after `withConsoleAccess()` accepts the request. */
export type ConsoleGuardedHandler<TEvent, TResult> = (event: TEvent, access: ConsoleAccess) => TResult | Promise<TResult>

/** The route that `withConsoleAccess()` returns for a handler. Route files use it to type their default export. */
export type ConsoleAccessRoute<THandler extends (event: never, access: ConsoleAccess) => unknown> = (event: Parameters<THandler>[0]) => Promise<Awaited<ReturnType<THandler>> | Response>

const policyKey: unique symbol = Symbol.for("vitehub.console.access")
const openWarningKey: unique symbol = Symbol.for("vitehub.console.access.open-warning")
// SAFETY: This module owns the process slots shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy, [openWarningKey]?: true }
const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
const checkedEvents = new WeakMap<object, ConsoleAccess>()
const routeScopes = new WeakMap<object, ConsoleRouteScope>()
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "open"])

/** The warning that a production server logs once when anyone can open the Console. */
export const consoleOpenAccessWarning = "[vitehub] console: { auth: false } has no sign-in. Anyone who can reach /_vitehub can use the Console. Set console.auth to \"app\" or a Console Auth config, or set console.authorize."

function rejection(status: number, message: string): Response {
  return Response.json({ message, ok: false, status }, {
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
  if ("user" in policy && policy.user !== undefined && !(policy.user instanceof Function)) {
    throw new TypeError("[vitehub] Console access user reader must be a function.")
  }
  if (policy.authorize !== undefined && !(policy.authorize instanceof Function)) {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  scope[policyKey] = Object.freeze({ ...policy })
  if (policy.mode === "open" && !policy.authorize && globalThis.process?.env?.NODE_ENV === "production" && !scope[openWarningKey]) {
    scope[openWarningKey] = true
    globalThis.console.warn(consoleOpenAccessWarning)
  }
}

/** Rebuild the host request for runtimes that need its headers, such as Auth sessions. */
export function consoleRequest(event: ConsoleRequestEvent): Request {
  if (event.req instanceof Request) return event.req
  const headers = new Headers()
  const requestHeaders = event.req?.headers ?? event.headers
  const iterableHeaders = requestHeaders as (ConsoleHeaders & { [Symbol.iterator]?: () => IterableIterator<[string, string]> }) | undefined
  const iterate = iterableHeaders?.[Symbol.iterator]
  if (iterate instanceof Function) {
    for (const [name, value] of iterate.call(iterableHeaders)) headers.set(name, value)
  }
  else if (requestHeaders) {
    // ConsoleHeaders intentionally guarantees get() without requiring iteration.
    // Preserve the request headers used by Auth and Console routing for that shape.
    for (const name of ["authorization", "cookie", "content-type", "origin", "host", "x-forwarded-host", "x-forwarded-proto"]) {
      const value = requestHeaders.get(name)
      if (value !== null) headers.set(name, value)
    }
  }
  for (const [name, value] of Object.entries(event.node?.req?.headers ?? {})) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return new Request(consoleRequestURL(event), { headers, method: event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET" })
}

// doctor-disable-next-line typescript/strict/no-runtime-typeof -- console.authorize is user code. Check each returned section id.
const isSectionId = (value: unknown): value is ConsoleSectionId => typeof value === "string" && value.length > 0

function authorizedSections(result: unknown): readonly ConsoleSectionId[] | undefined {
  if (!(result instanceof Object) || !("sections" in result) || !Array.isArray(result.sections)) return
  const sections: unknown[] = result.sections
  if (!sections.every(isSectionId)) return
  return Object.freeze([...new Set(sections)])
}

async function checkConsoleAccess(event: ConsoleRequestEvent, options: { user?: boolean } = {}): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "[vitehub] Console access is not configured. The generated Console output did not install an access policy.")
  let user: ConsoleUser | undefined
  if (policy.mode !== "open") {
    if (!policy.check) {
      return rejection(500, policy.mode === "auth"
        ? "[vitehub] console: { auth: \"app\" } requires a discovered ViteHub Auth Definition."
        : "[vitehub] Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) return response
    if (policy.user && (options.user || policy.authorize)) user = await policy.user(event)
  }
  let sections: ConsoleAccess["sections"] = "all"
  if (policy.authorize) {
    const request = consoleRequest(event)
    const result: unknown = await policy.authorize(user ? { request, user } : { request })
    if (result instanceof Response) return result
    if (result === false) return rejection(403, "Forbidden.")
    if (result !== true) {
      const allowed = authorizedSections(result)
      if (!allowed) return rejection(500, "[vitehub] console.authorize must return true, false, a Response, or { sections: string[] }.")
      if (!allowed.length) return rejection(403, "Forbidden.")
      sections = allowed
    }
  }
  const fields: { mode: ConsoleAccessMode, sections: ConsoleAccess["sections"], user?: ConsoleUser } = { mode: policy.mode, sections }
  if (user) fields.user = user
  return consoleAccessGrant.issue(policy.mode, fields)
}

/**
 * Return whether a checked access may use one Console section. An unknown section needs access to every section.
 * An access that `withConsoleAccess()` did not create allows nothing.
 */
export function consoleAccessAllows(access: ConsoleAccess, section: ConsoleSectionId | undefined): boolean {
  if (!consoleAccessGrant.isValid(access)) return false
  return access.sections === "all" || (section !== undefined && access.sections.includes(section))
}

/** Return the sections of `available` that a checked access may use. */
export function allowedConsoleSections(access: ConsoleAccess, available: readonly ConsoleSectionId[]): ConsoleSectionId[] {
  return available.filter(section => consoleAccessAllows(access, section))
}

/**
 * Name the manager of one Connections management request with the installed Console access policy.
 * The generated Connections actor module calls it, so Connections routes and Console data routes share one policy.
 * - `auth`: the signed-in user as `user:<id>`.
 * - `open` and `cloudflare-access` have no user id. The manager is `user:<mode>`.
 * Returns `undefined` when the policy rejects the request or the access does not include the Connections section.
 * The Connections handler then returns `403`.
 */
export async function consoleConnectionsActor(event: ConsoleRequestEvent): Promise<string | undefined> {
  const access = await checkConsoleAccess(event, { user: true })
  if (access instanceof Response || !consoleAccessAllows(access, "connections")) return undefined
  if (access.mode === "auth") return access.user ? `user:${access.user.id}` : undefined
  return `user:${access.mode}`
}

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

function resolveRouteSection(routeScope: ConsoleRouteScope, event: ConsoleRequestEvent): { section: ConsoleSectionId | undefined } | undefined {
  if (!("section" in routeScope)) return
  return { section: routeScope.section instanceof Function ? routeScope.section(event) : routeScope.section }
}

function assertRouteScope(routeScope: unknown): asserts routeScope is ConsoleRouteScope {
  if (!(routeScope instanceof Object)) throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
  if ("section" in routeScope) {
    const section = routeScope.section
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Route scopes cross the JavaScript module boundary.
    if (section instanceof Function || (typeof section === "string" && section.length > 0)) return
  }
  if ("anySection" in routeScope && routeScope.anySection === true) return
  throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request,
 * and only when the access includes the route section. Otherwise the wrapper returns the rejection `Response`:
 * `403` outside the allowed sections, and `500` without an installed policy.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
  routeScope: ConsoleRouteScope,
): (event: TEvent) => Promise<TResult | Response> {
  if (!(handler instanceof Function)) throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  assertRouteScope(routeScope)
  const declared: ConsoleRouteScope = Object.freeze({ ...routeScope })
  const route = async (event: TEvent): Promise<TResult | Response> => {
    let access = checkedEvents.get(event)
    if (!access || !consoleAccessGrant.isValid(access)) {
      const checked = await checkConsoleAccess(event, { user: declared.user === true })
      if (checked instanceof Response) return checked
      checkedEvents.set(event, checked)
      access = checked
    }
    const section = resolveRouteSection(declared, event)
    if (section && !consoleAccessAllows(access, section.section)) return rejection(403, "This Console access does not include this section.")
    return handler(event, access)
  }
  routeScopes.set(route, declared)
  return route
}

/** Return the section scope that `withConsoleAccess()` declared for a route, or `undefined` for an unguarded function. */
export function consoleRouteScope(route: unknown): ConsoleRouteScope | undefined {
  return route instanceof Function ? routeScopes.get(route) : undefined
}

/**
 * Bind a checked Console access to an internal event, such as one Console RPC operation.
 * A guarded handler that receives this event uses the bound access. Rejects an access that `withConsoleAccess()` did not create.
 */
export function bindConsoleAccess<TEvent extends ConsoleRequestEvent>(access: ConsoleAccess, event: TEvent): TEvent {
  if (!consoleAccessGrant.isValid(access)) throw consoleRequestError(403, "Forbidden")
  if (checkedEvents.has(event)) throw consoleRequestError(500, "Console access is already bound to this request.")
  checkedEvents.set(event, access)
  return event
}
