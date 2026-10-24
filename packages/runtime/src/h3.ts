import { getCloudflareEnv, getCloudflareExecutionContext, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { createH3V1ResponseHeaders, isH3V1Event, toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"
import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"
import { createRuntimeContext } from "./index.ts"
import type { CloudflareWorkerExecutionContext } from "@vite-hub/internal/runtime/cloudflare-env"
import type { EventHandlerRequest } from "h3"
import type { StandardContext } from "standard-context"
import type { CreatedRuntimeContext, RuntimeContextInput, RuntimeHostContext } from "./index.ts"

/** The host data that ViteHub puts in `runtime` of a Standard Context. */
export interface ViteHubRuntime {
  cloudflare?: {
    context?: CloudflareWorkerExecutionContext
    env: Record<string, unknown>
  }
  /** The client IP address that the host reports. ViteHub does not read it from forwarding headers. */
  clientAddress?: string
}

/** The `~standard` properties of a request event in a ViteHub app. */
export type ViteHubStandardProps = StandardContext.Props<ViteHubRuntime, void>

/** A request event in a ViteHub app: any server context with Standard Context properties. */
export type ViteHubContext<C = {}> = StandardContext<C, ViteHubRuntime, void>

declare module "h3" {
  // The type parameters must match the H3Event class of H3 1 and H3 2.
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
 * Return true for the Request of an H3 2 event. Hosts pass their own Request classes, such as srvx's Node
 * request or a Request from another realm, so check the fields that ViteHub reads instead of the prototype.
 */
function isHostRequest(value: unknown): value is Request {
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

function h3V2ClientAddress(request: Request): string | undefined {
  // srvx adds the client address to the Request it passes to H3 2.
  const ip: unknown = Reflect.get(request, "ip")
  return typeof ip === "string" && ip ? ip : undefined
}

function createH3StandardProps(event: object): ViteHubStandardProps | undefined {
  let readRequest: () => Request
  let res: StandardContext.PreparedResponse
  let clientAddress: string | undefined
  const req: unknown = Object.hasOwn(event, "req") ? Reflect.get(event, "req") : undefined
  if (isHostRequest(req)) {
    const response: unknown = Reflect.get(event, "res")
    const headers: unknown = isObjectLike(response) ? Reflect.get(response, "headers") : undefined
    if (!isObjectLike(headers) || typeof Reflect.get(headers, "set") !== "function") return undefined
    // SAFETY: H3 2 events expose an H3EventResponse with mutable status and a Headers object.
    res = preparedResponse(response as PreparedResponseTarget)
    readRequest = () => req
    clientAddress = h3V2ClientAddress(req)
  }
  else if (isH3V1Event(event)) {
    const response = event.node.res
    if (!response) return undefined
    const headers = createH3V1ResponseHeaders(response)
    res = preparedResponse({
      headers,
      get status() {
        return response.statusCode
      },
      set status(value) {
        if (value !== undefined) response.statusCode = value
      },
    })
    readRequest = () => toH3V1Request(event)
    clientAddress = event.node.req.socket?.remoteAddress || event.node.req.connection?.remoteAddress || undefined
  }
  else {
    return undefined
  }
  const env = getCloudflareEnv(event, { fallback: false })
  const context = getCloudflareExecutionContext(event)
  const waitUntil = resolveWaitUntil(event, { preferHost: true })
  const runtime: ViteHubRuntime = {
    ...(env ? { cloudflare: { env, ...(context ? { context } : {}) } } : {}),
    ...(clientAddress ? { clientAddress } : {}),
  }
  return {
    vendor: "h3",
    // H3 1 builds the Request on first read, so a route that reads the Node body stream keeps working.
    get req() {
      return readRequest()
    },
    res,
    runtime,
    ...(waitUntil ? { waitUntil } : {}),
  }
}

/**
 * Set `event["~standard"]` on an H3 1 or H3 2 event. A value that the host set stays.
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
  // Synthetic events may provide their request directly. Preserve that override
  // instead of requiring an H3 request shape before the context can be created.
  if (options.request === undefined) installStandardContext(event)
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
