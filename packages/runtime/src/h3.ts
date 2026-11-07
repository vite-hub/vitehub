import { getCloudflareEnv, getCloudflareExecutionContext, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"
import { createRuntimeContext } from "./index.ts"
import type { EventHandlerRequest } from "h3"
import type { StandardContext } from "standard-context"
import type { CreatedRuntimeContext, RuntimeContextInput, RuntimeHostContext } from "./index.ts"
import type { ViteHubContext, ViteHubRuntime, ViteHubStandardProps } from "./standard-context.ts"

export type { ViteHubContext, ViteHubRuntime, ViteHubStandardProps } from "./standard-context.ts"

declare module "h3" {
  // The type parameters must match the H3Event class of H3 2.
  interface H3Event<_RequestT extends EventHandlerRequest = EventHandlerRequest> {
    /** Set by ViteHub for each request until H3 implements Standard Context. */
    readonly "~standard": ViteHubStandardProps
  }
}

type H3RuntimeName = "cloudflare-agents" | "deno" | "unknown" | "vercel" | "vite"

export type H3RuntimeContextOptions = Omit<RuntimeContextInput, "event" | "runtime"> & {
  runtime?: H3RuntimeName
}

export type H3RuntimeContext<TOptions extends H3RuntimeContextOptions = {}> = CreatedRuntimeContext<
  TOptions & {
    cloudflare?: RuntimeHostContext["cloudflare"]
    event: ViteHubContext
    request: Request
    runtime: H3RuntimeName
    vercel?: RuntimeHostContext["vercel"]
  }
>

function detectRuntime(cloudflare: boolean): H3RuntimeName {
  if (cloudflare) return "cloudflare-agents"
  if ("Deno" in globalThis) return "deno"
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Hosts can omit the process global; test its presence before reading Node environment variables.
  if (typeof process !== "undefined") {
    if (process.env.VERCEL) return "vercel"
    if (process.env.NODE_ENV === "development") return "vite"
  }
  return "unknown"
}

/**
 * Return true for the Request of an H3 2 event. Hosts pass their own Request classes, such as a Request from
 * another realm, so check the fields that ViteHub reads when the prototype does not match. srvx's Node request
 * inherits from Request, and the prototype check does not run its lazy `url` and `headers` getters.
 */
function isHostRequest(value: unknown): value is Request {
  if (value instanceof Request) return true
  if (!isObjectLike(value)) return false
  const headers: unknown = Reflect.get(value, "headers")
  return typeof Reflect.get(value, "url") === "string"
    && typeof Reflect.get(value, "method") === "string"
    && isObjectLike(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

interface PreparedResponseTarget {
  headers: Headers
  status?: number
}

type WaitUntil = NonNullable<ViteHubStandardProps["waitUntil"]>

/** Map Standard Context response fields to the response that H3 sends. H3 sends the value the handler returns as the body. */
function preparedResponse(target: PreparedResponseTarget): StandardContext.PreparedResponse {
  return {
    get body() {
      return undefined
    },
    set body(_value) {
      throw runtimeErrorDiagnostics.RUNTIME_R0016({ message: "[vitehub] H3 does not read `~standard.res.body`. Return the body or a Response from the handler." })
    },
    get headers() {
      return target.headers
    },
    set headers(value) {
      // Copy the names first. Deleting while iterating Headers skips entries.
      for (const name of Array.from(target.headers.keys())) target.headers.delete(name)
      for (const [name, item] of value ?? []) target.headers.append(name, item)
    },
    get status() {
      return target.status
    },
    set status(value) {
      target.status = value
    },
  }
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) current = isObjectLike(current) ? Reflect.get(current, key) : undefined
  return current
}

/** The first non-empty string at one of `paths`. ViteHub never reads forwarding headers here. */
function firstAddress(value: object, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const address = readPath(value, path)
    if (typeof address === "string" && address) return address
  }
  return undefined
}

/**
 * The places where hosts put the peer address of an H3 2 request, in the order of H3's `getRequestIP()`: a host
 * adapter sets `context.clientAddress`, and srvx sets `ip` and keeps the Node request in `runtime.node`.
 */
const h3V2AddressPaths = [["context", "clientAddress"], ["ip"], ["runtime", "node", "req", "socket", "remoteAddress"]] as const

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
    const clientAddress = firstAddress(this.#request, h3V2AddressPaths)
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
 * Set `event["~standard"]` on an H3 2 event. A value that the host set stays.
 * ViteHub calls this for each request in a Nitro `request` hook. Call it yourself only for an event that
 * Nitro did not create, such as in a test. Throws `RUNTIME_R0015` when the event has no request.
 */
export function installStandardContext<T extends object>(event: T): asserts event is T & ViteHubContext {
  if ("~standard" in event) return
  const props = createH3StandardProps(event)
  if (!props) {
    throw runtimeErrorDiagnostics.RUNTIME_R0015({ message: "[vitehub] The event has no request, so ViteHub cannot set `~standard`. Pass the event of an H3 or Nitro route." })
  }
  Object.defineProperty(event, "~standard", { configurable: true, enumerable: false, value: props })
}

/**
 * Return `event["~standard"]`. ViteHub primitives read request events through this function. It sets Standard
 * Context first when Nitro did not, such as for an H3 app without the ViteHub Vite plugin or an event in a test.
 * Throws `RUNTIME_R0015` when the event has no request.
 */
export function getStandardContext(event: ViteHubContext): ViteHubStandardProps {
  installStandardContext(event)
  return event["~standard"]
}

/** Adapt one request. Await flushWaitUntil when the host has no lifetime API. */
export function getRuntimeContext(event: ViteHubContext): H3RuntimeContext
export function getRuntimeContext<const TOptions extends H3RuntimeContextOptions>(
  event: ViteHubContext,
  options: TOptions,
): H3RuntimeContext<TOptions>
export function getRuntimeContext(
  event: ViteHubContext,
  options: H3RuntimeContextOptions = {},
): H3RuntimeContext<H3RuntimeContextOptions> {
  // Keep host resources when replacing the request, while still allowing a
  // synthetic event to provide only the explicit request override.
  if (!(event as Partial<ViteHubContext>)["~standard"]) {
    try {
      installStandardContext(event)
    }
    catch (error) {
      if (options.request === undefined || (error as { name?: unknown })?.name !== "RUNTIME_R0015") throw error
    }
  }
  const standard = (event as Partial<ViteHubContext>)["~standard"]
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
    event,
    runtime,
    ...(runtime === "vercel" && waitUntil ? { vercel: { waitUntil } } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  })
}
