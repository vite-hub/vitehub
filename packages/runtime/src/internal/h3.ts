import { getCloudflareEnv, getCloudflareExecutionContext, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { runtimeErrorDiagnostics } from "../error-diagnostics.ts"
import { createStandardRuntimeContext, firstAddress, getStandardContext as getRequestStandardContext, installRequestStandardContext, isHostRequest, requestAddressPaths } from "../request-context.ts"
import type { EventHandlerRequest } from "h3"
import type { StandardContext } from "standard-context"
import type { RequestRuntimeContext, RuntimeContextOptions } from "../request-context.ts"
import type { ViteHubContext, ViteHubRuntime, ViteHubStandardProps } from "../standard-context.ts"

export type { ViteHubContext, ViteHubRuntime, ViteHubStandardProps } from "../standard-context.ts"

declare module "h3" {
  // The type parameters must match the H3Event class of H3 2.
  interface H3Event<_RequestT extends EventHandlerRequest = EventHandlerRequest> {
    /** Set by ViteHub for each request until H3 implements Standard Context. */
    readonly "~standard": ViteHubStandardProps
  }
}

export type H3RuntimeContextOptions = RuntimeContextOptions

/**
 * A request event without Standard Context types, such as the event of a `nuxt/server` handler: a web Request and the
 * response that the host prepares. `getStandardContext()` sets `~standard` on it.
 */
export interface HostRequestEvent {
  readonly req: Request
  readonly res: { status?: number, readonly headers: Headers }
}

export type H3RuntimeContext<TOptions extends H3RuntimeContextOptions = {}> = RequestRuntimeContext<TOptions>

interface PreparedResponseTarget {
  headers: Headers
  errHeaders?: Headers
  status?: number
}

type WaitUntil = NonNullable<ViteHubStandardProps["waitUntil"]>

/** H3 2 uses separate headers for returned error Responses. Mirror only Standard Context writes to both. */
function responseHeaders(target: PreparedResponseTarget): Headers {
  const { headers, errHeaders } = target
  if (!errHeaders) return headers
  const view = new Headers()
  const methods: Pick<Headers, "append" | "delete" | "entries" | "forEach" | "get" | "getSetCookie" | "has" | "keys" | "set" | "values" | typeof Symbol.iterator> = {
    append(name, value) {
      headers.append(name, value)
      errHeaders.append(name, value)
    },
    delete(name) {
      headers.delete(name)
      errHeaders.delete(name)
    },
    entries: headers.entries.bind(headers),
    forEach(callback, thisArg) {
      headers.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    get: headers.get.bind(headers),
    getSetCookie: headers.getSetCookie.bind(headers),
    has: headers.has.bind(headers),
    keys: headers.keys.bind(headers),
    set(name, value) {
      headers.set(name, value)
      errHeaders.set(name, value)
    },
    values: headers.values.bind(headers),
    [Symbol.iterator]: headers[Symbol.iterator].bind(headers),
  }
  return Object.assign(view, methods)
}

/** Map Standard Context response fields to the response that H3 sends. H3 sends the value the handler returns as the body. */
function preparedResponse(target: PreparedResponseTarget): StandardContext.PreparedResponse {
  const headers = responseHeaders(target)
  return {
    get body() {
      return undefined
    },
    set body(_value) {
      throw runtimeErrorDiagnostics.RUNTIME_R0016({ message: "[vitehub] H3 does not read `~standard.res.body`. Return the body or a Response from the handler." })
    },
    get headers() {
      return headers
    },
    set headers(value) {
      // Copy the names first. Deleting while iterating Headers skips entries.
      for (const name of Array.from(headers.keys())) headers.delete(name)
      for (const [name, item] of value ?? []) headers.append(name, item)
    },
    get status() {
      return target.status
    },
    set status(value) {
      target.status = value
    },
  }
}

/**
 * The `~standard` properties of one H3 event. Each property reads the event on first access and keeps the value,
 * because most requests never read Standard Context and ViteHub sets it on every request.
 */
class H3StandardProps implements ViteHubStandardProps {
  readonly vendor = "h3"
  readonly #event: object
  readonly #request: Request
  #res: StandardContext.PreparedResponse | undefined
  #runtime: ViteHubRuntime | undefined
  #waitUntil: WaitUntil | null | undefined

  constructor(event: object, request: Request) {
    this.#event = event
    this.#request = request
  }

  get req(): Request {
    return this.#request
  }

  get res(): StandardContext.PreparedResponse {
    // SAFETY: H3 2 events expose an H3EventResponse with mutable status and a Headers object.
    return this.#res ??= preparedResponse(Reflect.get(this.#event, "res") as PreparedResponseTarget)
  }

  get runtime(): ViteHubRuntime {
    if (this.#runtime) return this.#runtime
    const env = getCloudflareEnv(this.#event, { fallback: false })
    const context = getCloudflareExecutionContext(this.#event)
    const clientAddress = firstAddress(this.#request, requestAddressPaths)
    // A host can pass the execution context without bindings on the event, so keep each one that it passes.
    return this.#runtime = {
      ...(env || context ? { cloudflare: { ...(env ? { env } : {}), ...(context ? { context } : {}) } } : {}),
      ...(clientAddress ? { clientAddress } : {}),
    }
  }

  get waitUntil(): WaitUntil | undefined {
    if (this.#waitUntil === undefined) this.#waitUntil = resolveWaitUntil(this.#event, { preferHost: true }) ?? null
    return this.#waitUntil ?? undefined
  }
}

function createH3StandardProps(event: object): ViteHubStandardProps | undefined {
  const req: unknown = Object.hasOwn(event, "req") ? Reflect.get(event, "req") : undefined
  return isHostRequest(req) && "res" in event ? new H3StandardProps(event, req) : undefined
}

/**
 * Set `event["~standard"]` on an H3 2 event. A value that the host set stays. ViteHub also sets the same value on
 * `event.req`, so a Fetchable handler that receives only the Request reads the same Standard
 * Context, and H3 adds the headers that primitives set to the Response that the handler returns.
 * ViteHub calls this for each request in a Nitro `request` hook. Call it yourself only for an event that
 * Nitro did not create, such as in a test. Throws `RUNTIME_R0015` when the event has no request.
 */
export function installStandardContext<T extends object>(event: T): asserts event is T & ViteHubContext {
  if (!("~standard" in event)) {
    const props = createH3StandardProps(event)
    if (!props) {
      throw runtimeErrorDiagnostics.RUNTIME_R0015({ message: "[vitehub] The event has no request, so ViteHub cannot set `~standard`. Pass the event of an H3 or Nitro route." })
    }
    Object.defineProperty(event, "~standard", { configurable: true, enumerable: false, value: props })
  }
  const req: unknown = Object.hasOwn(event, "req") ? Reflect.get(event, "req") : undefined
  if (isHostRequest(req)) {
    // SAFETY: The event either carried Standard Context or received it above.
    installRequestStandardContext(req, Reflect.get(event, "~standard") as ViteHubStandardProps)
  }
}

/**
 * Return the Standard Context of an H3 event, a `nuxt/server` event, or a web Request. ViteHub primitives read request
 * events through this function. It sets Standard Context first when Nitro did not, such as for an H3 app without the
 * ViteHub Vite plugin or an event in a test. Throws `RUNTIME_R0015` when the event has no request.
 */
export function getStandardContext(value: Request | ViteHubContext | HostRequestEvent): ViteHubStandardProps {
  if (isHostRequest(value)) return getRequestStandardContext(value)
  installStandardContext(value)
  return value["~standard"]
}

/** Adapt one request. Pass an H3 event or a web Request. Await flushWaitUntil when the host has no lifetime API. */
export function getRuntimeContext(value: Request | ViteHubContext): H3RuntimeContext
export function getRuntimeContext<const TOptions extends H3RuntimeContextOptions>(
  value: Request | ViteHubContext,
  options: TOptions,
): H3RuntimeContext<TOptions>
export function getRuntimeContext(
  value: Request | ViteHubContext,
  options: H3RuntimeContextOptions = {},
): H3RuntimeContext<H3RuntimeContextOptions> {
  if (isHostRequest(value)) return createStandardRuntimeContext(value, getRequestStandardContext(value), options)
  // Keep host resources when replacing the request, while still allowing a
  // synthetic event to provide only the explicit request override.
  if (!(value as Partial<ViteHubContext>)["~standard"]) {
    try {
      installStandardContext(value)
    }
    catch (error) {
      if (options.request === undefined || (error as { name?: unknown })?.name !== "RUNTIME_R0015") throw error
    }
  }
  return createStandardRuntimeContext(value, (value as Partial<ViteHubContext>)["~standard"], options)
}

export { installRequestStandardContext } from "../request-context.ts"
