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
  | { mode: "open" | "local" | "host-managed", authorize?: ConsoleAuthorize }
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
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "host-managed", "local", "open"])
const objectToString = Object.prototype.toString
const invalidAuthorizationResponse = Symbol("invalid authorization response")

async function authorizationResponse(value: unknown): Promise<Response | typeof invalidAuthorizationResponse | undefined> {
  try {
    if (value instanceof Response) return value
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary validates foreign Fetch fields before constructing a local Response.
    if (!value || typeof value !== "object") return undefined
    if (objectToString.call(value) !== "[object Response]") return undefined
    // A foreign Response cannot be branded by this realm's constructor. Validate
    // its transferable fields and let Fetch construct the route's actual Response.
    if (objectToString.call(value) !== "[object Response]"
      // A genuine Fetch Response exposes its tag on the prototype. An own tag
      // is caller-controlled and cannot establish the Response brand.
      || Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Fetch validates these primitive response-init fields below.
      || !("status" in value) || typeof value.status !== "number"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- These response-init strings are validated by Fetch below.
      || !("statusText" in value) || typeof value.statusText !== "string"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Headers validates the iterable below.
      || !("headers" in value) || !value.headers || typeof value.headers !== "object"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This is the iterable protocol check before Headers consumes it.
      || !(Symbol.iterator in value.headers) || typeof value.headers[Symbol.iterator] !== "function"
      || !("body" in value)) return invalidAuthorizationResponse
    // SAFETY: Headers validates the foreign iterable and all its entries at this boundary.
    const headers = new Headers(value.headers as Headers)
    const init = { headers, status: value.status, statusText: value.statusText }
    // Use the candidate implementation's clone algorithm so a Response from
    // another Fetch implementation can pass its own internal-slot check. The
    // returned clone is validated below, so compatible own methods are allowed.
    const prototype = Object.getPrototypeOf(value)
    let responsePrototype = prototype
    while (responsePrototype) {
      const cloneDescriptor = Object.getOwnPropertyDescriptor(responsePrototype, "clone")
      const tagDescriptor = Object.getOwnPropertyDescriptor(responsePrototype, Symbol.toStringTag)
      const constructor = Object.getOwnPropertyDescriptor(responsePrototype, "constructor")?.value
      const methods = ["arrayBuffer", "blob", "formData", "json", "text"]
      const hasResponseMethods = methods.every(method => {
        let methodPrototype: object | null = responsePrototype
        while (methodPrototype) {
          if (typeof Object.getOwnPropertyDescriptor(methodPrototype, method)?.value === "function") return true
          methodPrototype = Object.getPrototypeOf(methodPrototype)
        }
        return false
      })
      // These accessors are part of the complete Fetch Response surface. A
      // small caller-created prototype can imitate the transferable fields,
      // but it must not be mistaken for a Response implementation without
      // the rest of its standard accessors.
      const accessors = ["body", "bodyUsed", "headers", "status", "statusText", "type", "url", "redirected", "ok"]
      const hasResponseAccessors = accessors.every(method => {
        const descriptor = Object.getOwnPropertyDescriptor(responsePrototype, method)
        // Fetch implementations may expose these properties as own fields on
        // each instance (happy-dom does this) instead of prototype getters.
        return typeof descriptor?.get === "function" || Object.prototype.hasOwnProperty.call(value, method)
      })
      // At least one standard accessor must be implementation-owned on the
      // prototype. A caller-created prototype can copy the method and tag
      // descriptors, but cannot provide a genuine accessor-backed Response
      // surface while keeping all fields as arbitrary own values.
      const hasPrototypeAccessor = accessors.some(method =>
        typeof Object.getOwnPropertyDescriptor(responsePrototype, method)?.get === "function")
      if (typeof cloneDescriptor?.value === "function"
        && hasResponseMethods
        && hasResponseAccessors
        && hasPrototypeAccessor
        && tagDescriptor
        && typeof constructor === "function"
        && constructor.prototype === responsePrototype) break
      responsePrototype = Object.getPrototypeOf(responsePrototype)
    }
    // Genuine Fetch implementations expose both the clone algorithm and Response tag
    // on a Response prototype. Walking the chain accepts subclasses while rejecting
    // plain objects whose custom prototype only imitates those slots.
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Verify the foreign Response clone method before invoking it.
    if (!responsePrototype) return invalidAuthorizationResponse
    // A null body is valid for ordinary responses (for example, a bodyless
    // 401 challenge). Preserve that response while keeping the no-content
    // status restrictions below.
    if ([204, 205, 304].includes(value.status)) return invalidAuthorizationResponse
    if (value.body === null) return new Response(null, init)
    const cloneMethod = Reflect.get(value, "clone")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Verify the foreign Response clone method before invoking it.
    if (typeof cloneMethod !== "function") return invalidAuthorizationResponse
    const clone = Reflect.apply(cloneMethod, value, [])
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Narrow the foreign clone result before inspecting its fields.
    let clonePrototype = clone && typeof clone === "object" ? Object.getPrototypeOf(clone) : null
    let sharesResponsePrototype = false
    while (clonePrototype) {
      if (clonePrototype === responsePrototype) {
        sharesResponsePrototype = true
        break
      }
      clonePrototype = Object.getPrototypeOf(clonePrototype)
    }
    if (!clone || typeof clone !== "object" || clone === value || !sharesResponsePrototype
      || objectToString.call(clone) !== "[object Response]"
      || Object.prototype.hasOwnProperty.call(clone, Symbol.toStringTag)) return invalidAuthorizationResponse
    // A callable clone spoof must also expose the transferable Response contract.
    if (!("status" in clone) || typeof clone.status !== "number"
      || !("statusText" in clone) || typeof clone.statusText !== "string"
      || !("headers" in clone) || !clone.headers || typeof clone.headers !== "object"
      || !(Symbol.iterator in clone.headers) || typeof clone.headers[Symbol.iterator] !== "function"
      || !("body" in clone)) return invalidAuthorizationResponse
    // Validate init before taking ownership of a foreign stream.
    // Calling the native stream method checks its internal brand across realms;
    // piping into a local stream also avoids realm-sensitive Fetch body checks.
    // Read the foreign body through its own implementation, then construct the
    // local response from bytes so independently implemented Fetch realms work.
    if (!("arrayBuffer" in clone) || typeof clone.arrayBuffer !== "function") return invalidAuthorizationResponse
    const body = await Reflect.apply(clone.arrayBuffer, clone, [])
    return new Response(body as ArrayBuffer, init)
  }
  catch {
    return invalidAuthorizationResponse
  }
}


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
  if ("check" in policy && policy.check !== undefined && typeof policy.check !== "function") {
    throw new TypeError("[vitehub] Console access check must be a function.")
  }
  if ("user" in policy && policy.user !== undefined && typeof policy.user !== "function") {
    throw new TypeError("[vitehub] Console access user reader must be a function.")
  }
  if (policy.authorize !== undefined && typeof policy.authorize !== "function") {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  scope[policyKey] = Object.freeze({ ...policy })
  if (policy.mode === "open" && !policy.authorize && productionRuntime() && !scope[openWarningKey]) {
    scope[openWarningKey] = true
    globalThis.console.warn(consoleOpenAccessWarning)
  }
}

function productionRuntime(): boolean {
  return typeof globalThis.process === "undefined" || globalThis.process.env?.NODE_ENV === "production"
}

function developmentRuntime(): boolean {
  // Local Console access is safe only when the host identifies itself as a
  // development runtime. Missing or partial process objects are unknown.
  return globalThis.process?.env?.NODE_ENV === "development"
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
  // Authorization results may come from a different JavaScript realm.
  // `instanceof Object` rejects those objects, while a null/type guard is
  // sufficient before reading the documented `sections` property.
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Authorization results cross the JavaScript module boundary.
  if (!result || typeof result !== "object" || !("sections" in result) || !Array.isArray(result.sections)) return
  const sections: unknown[] = result.sections
  if (!sections.every(isSectionId)) return
  return Object.freeze([...new Set(sections)])
}

async function checkConsoleAccess(event: ConsoleRequestEvent, options: { user?: boolean } = {}): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "[vitehub] Console access is not configured. The generated Console output did not install an access policy.")
  let user: ConsoleUser | undefined
  let authorizeResult: unknown
  let authorizeResultReady = false
  if (policy.mode === "local") {
    if (!developmentRuntime()) return rejection(403, "[vitehub] console: true is development-only. Configure console: { access: \"auth\" } or console: { exposure: \"host-managed\", authorize } for production.")
  }
  else if (policy.mode === "host-managed") {
    if (!policy.authorize) {
      return rejection(500, "[vitehub] console: { exposure: \"host-managed\" } requires console.authorize. Set it to a server file that default-exports defineConsoleAuthorize().")
    }
    authorizeResult = await policy.authorize({ request: consoleRequest(event) })
    authorizeResultReady = true
  }
  else if (policy.mode === "auth" || policy.mode === "cloudflare-access") {
    if (!policy.check) {
      return rejection(500, policy.mode === "auth"
        ? "[vitehub] console: { auth: \"app\" } requires a discovered ViteHub Auth Definition."
        : "[vitehub] Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) {
      const normalized = await authorizationResponse(response)
      if (normalized === invalidAuthorizationResponse) return rejection(403, "Forbidden.")
      return normalized ?? rejection(403, "Forbidden.")
    }
    if (policy.user && (options.user || policy.authorize)) user = await policy.user(event)
  }
  let sections: ConsoleAccess["sections"] = "all"
  if (policy.authorize) {
    const request = consoleRequest(event)
    const result: unknown = authorizeResultReady
      ? authorizeResult
      : await policy.authorize(user ? { request, user } : { request })
    const response = await authorizationResponse(result)
    if (response === invalidAuthorizationResponse) return rejection(403, "Forbidden.")
    if (response) return response
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
