import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleRequestError, consoleRequestURL, type ConsoleRequestEvent } from "./request.ts"

import type { ConsoleAuthorize, ConsoleUser } from "../../auth.ts"
import type { ConsoleSectionId } from "../sections.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `local`: the development server, for `console: true` and development without an edge.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * - `host-managed`: the host-supplied `console.authorize` function.
 */
export type ConsoleAccessPolicy =
  | { mode: "local" }
  | { mode: "open", authorize?: ConsoleAuthorize }
  | { mode: "auth" | "cloudflare-access", check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>, authorize?: ConsoleAuthorize, user?: (event: ConsoleRequestEvent) => Promise<ConsoleUser | undefined> }
  | { mode: "host-managed", authorize?: ConsoleAuthorize }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]
export const consoleOpenAccessWarning = "[vitehub] Console access is open. Configure authentication or console.authorize."

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
  readonly sections: "all" | readonly ConsoleSectionId[]
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
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy }
const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
const checkedEvents = new WeakMap<object, ConsoleAccess>()
const routeScopes = new WeakMap<object, ConsoleRouteScope>()
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "host-managed", "local", "open"])

function rejection(status: number, message: string): Response {
  return Response.json({ message, ok: false, status }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status,
  })
}

function isRequestLike(value: unknown): value is Request {
  if (value === null || typeof value !== "object") return false
  try {
    const request = value as Record<string, unknown>
    const headers = request.headers
    const requestMethods = ["clone", "arrayBuffer", "blob", "formData", "json", "text"]
    return typeof request.method === "string"
      && typeof request.url === "string"
      && headers !== null
      && typeof headers === "object"
      && typeof (headers as { get?: unknown }).get === "function"
      && requestMethods.every((method) => typeof request[method] === "function")
      && "body" in request
      && "bodyUsed" in request
      && "signal" in request
  }
  catch {
    return false
  }
}

function isResponseLike(value: unknown): value is Response {
  if (value === null || typeof value !== "object") return false
  try {
    const response = value as Record<string, unknown>
    const headers = response.headers
    const headerMethods = ["get", "set", "has", "append", "delete", "forEach"]
    const responseMethods = ["clone", "arrayBuffer", "blob", "formData", "json", "text"]
    let nativeBrand = false
    try {
      // SAFETY: Response.prototype.body is the platform getter and performs the internal-slot brand check.
      Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get?.call(value)
      nativeBrand = true
    }
    catch {
      // Foreign implementations (for example happy-dom) do not share the platform slots.
    }
    // happy-dom stores its response state in enumerable own symbols. Require the
    // complete state set when accepting a shimmed implementation so copied public
    // slots on an ordinary object still fail closed.
    const shimStateSymbols = new Set(["cachedResponse", "buffer", "virtualServerFile", "aborted", "error", "body"])
    const hasShimState = Object.getOwnPropertySymbols(value).every(symbol => shimStateSymbols.has(symbol.description ?? ""))
      && Object.getOwnPropertySymbols(value).some(symbol => symbol.description === "body")
      && shimStateSymbols.size === Object.getOwnPropertySymbols(value).length
    // Native Responses are identified by the platform getter's internal-slot
    // check. Supported DOM shims expose their complete private state symbols;
    // require that state rather than accepting forgeable public properties,
    // constructors, or factory methods as a response brand.
    const foreignImplementation = hasShimState
    return typeof response.status === "number"
      && typeof response.statusText === "string"
      && (nativeBrand || foreignImplementation)
      && headers !== null
      && typeof headers === "object"
      && headerMethods.every((method) => typeof (headers as Record<string, unknown>)[method] === "function")
      && responseMethods.every((method) => typeof response[method] === "function")
  }
  catch {
    return false
  }
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
  scope[policyKey] = Object.freeze({ ...policy })
}

function productionRuntime(): boolean {
  return globalThis.process?.env?.NODE_ENV === "production"
}

function webRequest(event: ConsoleRequestEvent): Request {
  if (event.req instanceof Request || isRequestLike(event.req)) return event.req
  const headers = new Headers()
  for (const [name, value] of Object.entries(event.node?.req?.headers ?? {})) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return new Request(consoleRequestURL(event), { headers, method: event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET" })
}

async function checkConsoleAccess(event: ConsoleRequestEvent): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "[vitehub] Console access is not configured. The generated Console output did not install an access policy.")
  if (policy.mode === "local") {
    if (productionRuntime()) return rejection(403, "[vitehub] console: true is development-only. Configure console: { access: \"auth\" } or console: { exposure: \"host-managed\", authorize } for production.")
  }
  else if (policy.mode === "host-managed" || policy.mode === "open") {
    if (!policy.authorize) {
      if (policy.mode === "open") return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: "all" })
      return rejection(500, "[vitehub] console: { exposure: \"host-managed\" } requires console.authorize. Set it to a server file that default-exports defineConsoleAuthorize().")
    }
    if (policy.authorize) {
      const user = "user" in policy && policy.user ? await policy.user(event) : undefined
      const result = await policy.authorize({ request: webRequest(event), user })
      if (result instanceof Response || isResponseLike(result)) return result
      if (result === true) return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: "all", ...(user ? { user } : {}) })
      if (result && typeof result === "object" && Array.isArray(result.sections)) {
        if (!result.sections.every((section): section is ConsoleSectionId => typeof section === "string" && section.length > 0)) {
          return rejection(500, "[vitehub] console.authorize returned an invalid section list.")
        }
        return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: result.sections, ...(user ? { user } : {}) })
      }
      return rejection(403, "Forbidden.")
    }
  }
  else {
    if (!policy.check) {
      return rejection(500, policy.mode === "auth"
        ? "[vitehub] console: { access: \"auth\" } requires a discovered ViteHub Auth Definition."
        : "[vitehub] Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) return response
    if (policy.authorize) {
      const user = "user" in policy && policy.user ? await policy.user(event) : undefined
      const result = await policy.authorize({ request: webRequest(event), user })
      if (result instanceof Response || isResponseLike(result)) return result
      if (result === true) return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: "all", ...(user ? { user } : {}) })
      if (result && typeof result === "object" && Array.isArray(result.sections)) {
        if (!result.sections.every((section): section is ConsoleSectionId => typeof section === "string" && section.length > 0)) {
          return rejection(500, "[vitehub] console.authorize returned an invalid section list.")
        }
        return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: result.sections, ...(user ? { user } : {}) })
      }
      return rejection(403, "Forbidden.")
    }
  }
  return consoleAccessGrant.issue(policy.mode, { mode: policy.mode, sections: "all" })
}

/**
 * Name the manager of one Connections management request with the installed Console access policy.
 * The generated Connections actor module calls it, so Connections routes and Console data routes share one policy.
 * - `auth`: `sessionActor` reads the signed-in user as `user:<id>`.
 * - `local`, `host-managed`, and `cloudflare-access` have no user id. The manager is `user:<mode>`.
 * Returns `undefined` when the policy rejects the request. The Connections handler then returns `403`.
 */
export async function consoleConnectionsActor(
  event: ConsoleRequestEvent,
  sessionActor?: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const access = await checkConsoleAccess(event)
  if (access instanceof Response || isResponseLike(access)) return undefined
  if (!consoleAccessAllows(access, "connections")) return undefined
  if (access.mode === "auth") return sessionActor ? await sessionActor() : undefined
  return `user:${access.mode}`
}

/** Return whether a checked access may use a Console section. */
export function consoleAccessAllows(access: ConsoleAccess, section: ConsoleSectionId | undefined): boolean {
  return consoleAccessGrant.isValid(access)
    && (access.sections === "all" || (section !== undefined && access.sections.includes(section)))
}

/** Return the sections visible to a checked access. */
export function allowedConsoleSections(access: ConsoleAccess, available: readonly ConsoleSectionId[]): ConsoleSectionId[] {
  return access.sections === "all" ? [...available] : available.filter(section => access.sections.includes(section))
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request.
 * Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
  routeScope: ConsoleRouteScope,
): (event: TEvent) => Promise<TResult | Response> {
  if (!(handler instanceof Function)) throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  if (!(routeScope instanceof Object)) throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
  if (!("anySection" in routeScope && routeScope.anySection === true) && !("section" in routeScope && (typeof routeScope.section === "string" && routeScope.section.length > 0 || routeScope.section instanceof Function))) {
    throw new TypeError("[vitehub] withConsoleAccess() requires { section } or { anySection: true }.")
  }
  const declared = Object.freeze({ ...routeScope }) as ConsoleRouteScope
  const route = async (event: TEvent) => {
    const bound = checkedEvents.get(event)
    const access = bound && consoleAccessGrant.isValid(bound) ? bound : await checkConsoleAccess(event)
    if (access instanceof Response || isResponseLike(access)) return access
    if ("section" in declared) {
      const section = declared.section instanceof Function ? declared.section(event) : declared.section
      if (section === undefined || !consoleAccessAllows(access, section)) return rejection(403, "Forbidden.")
    }
    checkedEvents.set(event, access)
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
  if (!consoleAccessGrant.isValid(access)) throw consoleRequestError(403, "Forbidden")
  if (checkedEvents.has(event)) throw consoleRequestError(500, "Console access is already bound to this request.")
  checkedEvents.set(event, access)
  return event
}
