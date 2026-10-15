import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleRequestError, consoleRequestURL, type ConsoleRequestEvent } from "./request.ts"

import type { ConsoleAuthorize } from "../../auth.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `local`: the development server, for `console: true` and development without an edge.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * - `host-managed`: the host-supplied `console.authorize` function.
 */
export type ConsoleAccessPolicy =
  | { mode: "local" }
  | { mode: "auth" | "cloudflare-access", check?: (event: ConsoleRequestEvent) => Promise<Response | undefined> }
  | { mode: "host-managed", authorize?: ConsoleAuthorize }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
}

/** A Console server handler that runs only after `withConsoleAccess()` accepts the request. */
export type ConsoleGuardedHandler<TEvent, TResult> = (event: TEvent, access: ConsoleAccess) => TResult | Promise<TResult>

/** The route that `withConsoleAccess()` returns for a handler. Route files use it to type their default export. */
export type ConsoleAccessRoute<THandler extends (event: never, access: ConsoleAccess) => unknown> = (event: Parameters<THandler>[0]) => Promise<Awaited<ReturnType<THandler>> | Response>

const policyKey: unique symbol = Symbol.for("vitehub.console.access")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy }
const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
const checkedEvents = new WeakMap<object, ConsoleAccess>()
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "host-managed", "local"])

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
    return typeof request.method === "string"
      && typeof request.url === "string"
      && headers !== null
      && typeof headers === "object"
      && typeof (headers as { get?: unknown }).get === "function"
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
    const ownSlots = ["bodyUsed", "redirected", "type", "url", "status", "statusText", "ok", "headers"]
      .every((key) => Object.prototype.hasOwnProperty.call(value, key))
    let hasBodyGetter = false
    let hasResponseTag = false
    let responseBodyGetter: (() => unknown) | undefined
    for (let prototype = Object.getPrototypeOf(value); prototype; prototype = Object.getPrototypeOf(prototype)) {
      const body = Object.getOwnPropertyDescriptor(prototype, "body")
      if (body && typeof body.get === "function") {
        hasBodyGetter = true
        responseBodyGetter = body.get
      }
      const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)
      if (tag) {
        const tagValue = typeof tag.get === "function" ? tag.get.call(value) : tag.value
        if (tagValue === "Response") hasResponseTag = true
      }
    }
    const constructor = Object.getPrototypeOf(value)?.constructor
    let factorySurface = false
    if (typeof constructor === "function") {
      try {
        // A foreign Response constructor must produce values using its own prototype.
        // This rejects copied host factory methods, which otherwise look like a
        // complete static surface on an ordinary object.
        const factoryResults = [
          (constructor as { json?: (data: unknown) => unknown }).json?.(null),
          (constructor as { redirect?: (url: string) => unknown }).redirect?.("https://console.example.test/"),
          (constructor as { error?: () => unknown }).error?.(),
        ]
        factorySurface = factoryResults.every((result, index) => result !== undefined
          && result !== value
          && factoryResults.indexOf(result) === index
          && Object.getPrototypeOf(result) === Object.getPrototypeOf(value))
      }
      catch {
        factorySurface = false
      }
    }
    const foreignImplementation = hasResponseTag
      && hasBodyGetter
      && typeof constructor === "function"
      && constructor.name === "Response"
      && typeof (constructor as { json?: unknown }).json === "function"
      && typeof (constructor as { redirect?: unknown }).redirect === "function"
      // All platform Response constructors expose the complete static factory surface.
      // Requiring `error` as well closes the copied-prototype constructor spoof while
      // retaining foreign implementations such as happy-dom.
      && typeof (constructor as { error?: unknown }).error === "function"
      // Native and foreign platform constructors expose non-enumerable static
      // factories. Requiring the descriptor shape prevents an ordinary object
      // from supplying an ad-hoc constructor with copied methods and slots.
      && ["json", "redirect", "error"].every((name) => {
        for (let owner = constructor; owner; owner = Object.getPrototypeOf(owner)) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, name)
          if (descriptor) {
            return descriptor.enumerable === false
              && descriptor.writable === true
              && descriptor.configurable === true
              && typeof descriptor.value === "function"
          }
        }
        return false
      })
      && constructor.prototype === Object.getPrototypeOf(value)
      && factorySurface
      // Node's Response stores its slots internally, while DOM shims commonly
      // expose them as own properties. Both forms are valid when the inspected
      // body getter accepts the value (or the shim exposes the complete shape).
      && (ownSlots || /\[native code\]/.test(Function.prototype.toString.call(responseBodyGetter)))
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
  else if (policy.mode === "host-managed") {
    if (!policy.authorize) {
      return rejection(500, "[vitehub] console: { exposure: \"host-managed\" } requires console.authorize. Set it to a server file that default-exports defineConsoleAuthorize().")
    }
    const result = await policy.authorize({ request: webRequest(event) })
    if (result instanceof Response || isResponseLike(result)) return result
    if (result !== true) return rejection(403, "Forbidden.")
  }
  else {
    if (!policy.check) {
      return rejection(500, policy.mode === "auth"
        ? "[vitehub] console: { access: \"auth\" } requires a discovered ViteHub Auth Definition."
        : "[vitehub] Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) return response
  }
  return consoleAccessGrant.issue(policy.mode, { mode: policy.mode })
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
  if (access.mode === "auth") return sessionActor ? await sessionActor() : undefined
  return `user:${access.mode}`
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request.
 * Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
): (event: TEvent) => Promise<TResult | Response> {
  if (!(handler instanceof Function)) throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  return async (event) => {
    const bound = checkedEvents.get(event)
    if (bound && consoleAccessGrant.isValid(bound)) return handler(event, bound)
    const access = await checkConsoleAccess(event)
    if (access instanceof Response || isResponseLike(access)) return access
    checkedEvents.set(event, access)
    return handler(event, access)
  }
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
