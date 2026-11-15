import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"
import { createRuntimeContext } from "./index.ts"
import type { StandardContext } from "standard-context"
import type { CreatedRuntimeContext, RuntimeContextInput, RuntimeHostContext } from "./index.ts"
import type { ViteHubContext, ViteHubRuntime, ViteHubStandardProps } from "./standard-context.ts"

export type RuntimeName = "cloudflare-agents" | "deno" | "unknown" | "vercel" | "vite"

export type RuntimeContextOptions = Omit<RuntimeContextInput, "event" | "runtime"> & {
  runtime?: RuntimeName
}

export type RequestRuntimeContext<TOptions extends RuntimeContextOptions = {}> = CreatedRuntimeContext<
  TOptions & {
    cloudflare?: RuntimeHostContext["cloudflare"]
    event: ViteHubContext
    request: Request
    runtime: RuntimeName
    vercel?: RuntimeHostContext["vercel"]
  }
>

type WaitUntil = NonNullable<ViteHubStandardProps["waitUntil"]>

export function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

/**
 * Return true for a web Request. Hosts pass their own Request classes, such as a Request from another realm, so
 * check the fields that ViteHub reads when the prototype does not match. srvx's Node request inherits from
 * Request, and the prototype check does not run its lazy `url` and `headers` getters.
 */
export function isHostRequest(value: unknown): value is Request {
  if (value instanceof Request) return true
  if (!isObjectLike(value)) return false
  const headers: unknown = Reflect.get(value, "headers")
  return typeof Reflect.get(value, "url") === "string"
    && typeof Reflect.get(value, "method") === "string"
    && isObjectLike(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

export function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) current = isObjectLike(current) ? Reflect.get(current, key) : undefined
  return current
}

/** The first non-empty string at one of `paths`. ViteHub never reads forwarding headers here. */
export function firstAddress(value: object, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const address = readPath(value, path)
    if (typeof address === "string" && address) return address
  }
  return undefined
}

/**
 * The places where hosts put the peer address of a request, in the order of H3's `getRequestIP()`: a host adapter
 * sets `context.clientAddress`, and srvx sets `ip` and keeps the Node request in `runtime.node`.
 */
export const requestAddressPaths = [["context", "clientAddress"], ["ip"], ["runtime", "node", "req", "socket", "remoteAddress"]] as const

/**
 * The `~standard` properties of a Request that no framework wraps, such as the Request of a Fetchable server
 * entry. srvx and Nitro put the host data on the Request: `runtime.cloudflare`, `waitUntil`, and `ip`.
 * Nothing reads `res` for you. Copy `res.status` and `res.headers` to the Response that you return.
 */
class RequestStandardProps implements ViteHubStandardProps {
  readonly vendor = "fetch"
  readonly req: Request
  readonly res: StandardContext.PreparedResponse = { headers: new Headers() }
  #runtime: ViteHubRuntime | undefined

  constructor(request: Request) {
    this.req = request
  }

  get runtime(): ViteHubRuntime {
    if (this.#runtime) return this.#runtime
    const cloudflare = readPath(this.req, ["runtime", "cloudflare"])
    const env = readPath(cloudflare, ["env"])
    const context = readPath(cloudflare, ["context"])
    const clientAddress = firstAddress(this.req, requestAddressPaths)
    return this.#runtime = {
      ...(isObjectLike(env) || isObjectLike(context)
        ? {
            cloudflare: {
              // SAFETY: Nitro and srvx store the Worker bindings and ExecutionContext under `runtime.cloudflare`.
              ...(isObjectLike(env) ? { env: env as Record<string, unknown> } : {}),
              // SAFETY: Nitro and srvx store the Worker bindings and ExecutionContext under `runtime.cloudflare`.
              ...(isObjectLike(context) ? { context: context as NonNullable<ViteHubRuntime["cloudflare"]>["context"] } : {}),
            },
          }
        : {}),
      ...(clientAddress ? { clientAddress } : {}),
    }
  }

  get waitUntil(): WaitUntil | undefined {
    for (const owner of [this.req, readPath(this.req, ["runtime", "cloudflare", "context"])]) {
      const waitUntil = readPath(owner, ["waitUntil"])
      // SAFETY: Hosts expose waitUntil(promise) on the Request or on the Worker ExecutionContext.
      if (typeof waitUntil === "function") return (waitUntil as WaitUntil).bind(owner)
    }
    return undefined
  }
}

const requestStandardContexts = new WeakMap<Request, ViteHubStandardProps>()

/** Keep one Standard Context per Request, even when it cannot be extended. A value set by the host stays. */
export function installRequestStandardContext(request: Request, standard?: ViteHubStandardProps): ViteHubStandardProps {
  if ("~standard" in request) return (request as Request & ViteHubContext)["~standard"]
  const props = standard ?? requestStandardContexts.get(request) ?? new RequestStandardProps(request)
  if (Object.isExtensible(request)) {
    Object.defineProperty(request, "~standard", { configurable: true, enumerable: false, value: props })
  }
  else {
    requestStandardContexts.set(request, props)
  }
  return props
}

/**
 * Return the Standard Context of a web Request or of a request event. In a Fetchable server entry, pass the
 * Request: `getStandardContext(request)`. In a ViteHub app, Nitro sets `~standard` on each event and on its
 * Request, so ViteHub keeps the response headers that primitives set. Throws `RUNTIME_R0015` for an event without
 * Standard Context.
 */
export function getStandardContext(value: Request | ViteHubContext): ViteHubStandardProps {
  if (isObjectLike(value) && "~standard" in value) return (value as ViteHubContext)["~standard"]
  if (isHostRequest(value)) return installRequestStandardContext(value)
  throw runtimeErrorDiagnostics.RUNTIME_R0015({ message: "[vitehub] The value is not a Request and has no `~standard`. Pass the Request of a Fetchable handler or the event of a route in a ViteHub app." })
}

function detectRuntime(cloudflare: boolean): RuntimeName {
  if (cloudflare) return "cloudflare-agents"
  if ("Deno" in globalThis) return "deno"
  if (typeof process !== "undefined") {
    if (process.env.VERCEL) return "vercel"
    if (process.env.NODE_ENV === "development") return "vite"
  }
  return "unknown"
}

/** Create the runtime context of one request from its Standard Context. The H3 entry shares this function. */
export function createStandardRuntimeContext(
  event: object,
  standard: ViteHubStandardProps | undefined,
  options: RuntimeContextOptions,
): RequestRuntimeContext<RuntimeContextOptions> {
  const request = options.request ?? standard?.req
  if (!request) {
    throw runtimeErrorDiagnostics.RUNTIME_R0015({ message: "[vitehub] The event has no request, so ViteHub cannot create a runtime context." })
  }
  const waitUntil = options.waitUntil?.bind(options)
    ?? options.vercel?.waitUntil?.bind(options.vercel)
    ?? standard?.waitUntil
  const cloudflare = options.cloudflare ?? standard?.runtime?.cloudflare
  const runtime = options.runtime ?? detectRuntime(!!cloudflare)
  return createRuntimeContext({
    request,
    ...options,
    ...(cloudflare ? { cloudflare } : {}),
    // SAFETY: The caller passes an object that carries `~standard` or an explicit request in `options`.
    event: event as ViteHubContext,
    runtime,
    ...(runtime === "vercel" && waitUntil ? { vercel: { waitUntil } } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  })
}

/**
 * Adapt one request. Pass the Request of a Fetchable handler or the event of a ViteHub app.
 * Await `flushWaitUntil()` when the host has no lifetime API.
 */
export function getRuntimeContext(value: Request | ViteHubContext): RequestRuntimeContext
export function getRuntimeContext<const TOptions extends RuntimeContextOptions>(
  value: Request | ViteHubContext,
  options: TOptions,
): RequestRuntimeContext<TOptions>
export function getRuntimeContext(
  value: Request | ViteHubContext,
  options: RuntimeContextOptions = {},
): RequestRuntimeContext<RuntimeContextOptions> {
  return createStandardRuntimeContext(value, getStandardContext(value), options)
}
