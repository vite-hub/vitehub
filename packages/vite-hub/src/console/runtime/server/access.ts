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
  | { mode: "open" | "local" | "host-managed", authorize?: ConsoleAuthorize }
  | { mode: "auth" | "cloudflare-access", authorize?: ConsoleAuthorize, check?: (event: ConsoleRequestEvent) => Promise<Response | undefined>, user?: (event: ConsoleRequestEvent) => Promise<ConsoleUser | undefined> }

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
      const constructorPrototype = typeof constructor === "function"
        ? Object.getOwnPropertyDescriptor(constructor, "prototype")
        : undefined
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
      // Require an implementation accessor on the prototype. The tag is excluded
      // because it is caller-controlled and must not count as a brand signal.
      const prototypeAccessorCount = accessors.filter(method =>
        typeof Object.getOwnPropertyDescriptor(responsePrototype, method)?.get === "function").length
      const hasPrototypeAccessor = prototypeAccessorCount >= 1
      let hasConstructibleResponse = false
      let hasFactoryBrand = false
      let hasNativeConstructorLineage = false
      if (typeof constructor === "function") {
        // A genuine Fetch constructor is an ordinary function constructor whose
        // parent is that realm's intrinsic Function.prototype. Caller-created
        // derived classes retain a caller-controlled parent and must fail closed.
        const constructorParent = Object.getPrototypeOf(constructor)
        const parentConstructor = constructorParent && Object.getOwnPropertyDescriptor(constructorParent, "constructor")?.value
        const constructorSource = Function.prototype.toString.call(constructor)
        // Fetch Response constructors are class/native implementations. An
        // ordinary caller-created function can reproduce every public field
        // and factory above, but cannot provide a native function body. Keep
        // class-based foreign implementations (such as happy-dom) supported.
        const isClassConstructor = /^class(?:\s|$)/.test(constructorSource)
        hasNativeConstructorLineage = (isClassConstructor || constructorSource.includes("[native code]"))
          && typeof parentConstructor === "function"
          && parentConstructor.prototype === constructorParent
          && parentConstructor.name === "Function"
          // A caller-created derived constructor can supply a Function-shaped
          // parent. Require the intrinsic constructor source as an additional
          // signal before accepting the foreign Response prototype.
          && Function.prototype.toString.call(parentConstructor) === "function Function() { [native code] }"
        try {
          const constructed = new constructor()
          hasConstructibleResponse = constructed && typeof constructed === "object"
            && Object.getPrototypeOf(constructed) === responsePrototype

          // Fetch constructors expose static factories that create genuinely
          // branded Responses. Calling one with the candidate constructor as
          // `this` rejects copied factories on caller-created classes: their
          // result belongs to the host Response prototype, outside this
          // candidate implementation's prototype chain.
          const factories = [
            ["error", []],
            ["json", [null]],
            ["redirect", ["https://example.com"]],
          ] as const
          hasFactoryBrand = factories.every(([name, args]) => {
            const factory = Object.getOwnPropertyDescriptor(constructor, name)?.value
            if (typeof factory !== "function") return false
            const factoryResult = Reflect.apply(factory, constructor, args)
            if (!factoryResult || typeof factoryResult !== "object"
              || objectToString.call(factoryResult) !== "[object Response]"
              || Object.prototype.hasOwnProperty.call(factoryResult, Symbol.toStringTag)) return false
            let factoryPrototype = Object.getPrototypeOf(factoryResult)
            while (factoryPrototype) {
              if (factoryPrototype === responsePrototype) return true
              factoryPrototype = Object.getPrototypeOf(factoryPrototype)
            }
            return false
          })
        }
        catch {
          hasConstructibleResponse = false
          hasFactoryBrand = false
        }
      }
      if (typeof cloneDescriptor?.value === "function"
        && hasResponseMethods
        && hasResponseAccessors
        && hasPrototypeAccessor
        && hasConstructibleResponse
        && hasNativeConstructorLineage
        && hasFactoryBrand
        && tagDescriptor
        && typeof constructor === "function"
        // A genuine Response constructor owns an immutable prototype slot.
        // Caller-created function constructors have a writable prototype by
        // default, so this rejects self-consistent prototype spoofs without
        // relying on the constructor name or realm identity.
        && constructorPrototype?.value === responsePrototype
        && constructorPrototype.writable === false
        && constructorPrototype.configurable === false
        // Fetch Response constructors expose the standard static factory
        // methods. Requiring these implementation-owned methods prevents a
        // caller-created class with a forged prototype from passing the
        // structural checks above.
        && typeof constructor.error === "function"
        && typeof constructor.json === "function"
        && typeof constructor.redirect === "function"
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
    return value.body === null ? new Response(null, init) : new Response(body as ArrayBuffer, init)
  }
  catch {
    return invalidAuthorizationResponse
  }
}

const deferredUsers = new WeakMap<ConsoleAccess, () => Promise<ConsoleUser | undefined>>()

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

function isSectionId(value: unknown): value is ConsoleSectionId {
  return typeof value === "string" && value.length > 0
}

function authorizedSections(result: unknown): readonly ConsoleSectionId[] | undefined {
  // Authorization results may come from a different JavaScript realm.
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Authorization results cross the JavaScript module boundary.
  if (!result || typeof result !== "object" || !("sections" in result) || !Array.isArray(result.sections)) return
  const sections: unknown[] = result.sections
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
  let authorizeResult: unknown
  let authorizeResultReady = false
  if (policy.mode === "local") {
    if (!developmentRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  } else if (policy.mode === "host-managed") {
    if (!policy.authorize) return rejection(500, "CONSOLE_AUTHORIZE_REQUIRED")
    authorizeResult = await policy.authorize({ request: consoleRequest(event) })
    authorizeResultReady = true
  } else if (policy.mode === "auth" || policy.mode === "cloudflare-access") {
    if (!policy.check) return rejection(500, "CONSOLE_AUTH_NOT_CONFIGURED")
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
    const result: unknown = authorizeResultReady ? authorizeResult : await policy.authorize(user ? { request, user } : { request })
    const response = await authorizationResponse(result)
    if (response === invalidAuthorizationResponse) return rejection(403, "Forbidden.")
    if (response) return response
    if (result === false) return rejection(403, "CONSOLE_ACCESS_DENIED")
    if (result !== true) {
      const allowed = authorizedSections(result)
      if (!allowed) return rejection(500, "CONSOLE_REQUEST_FAILED")
      if (!allowed.length) return rejection(403, "CONSOLE_ACCESS_DENIED")
      sections = allowed
    }
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
