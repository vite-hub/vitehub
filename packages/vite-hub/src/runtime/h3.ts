import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeContext } from "@vite-hub/runtime"
import type { CreatedRuntimeContext, RuntimeContextInput, RuntimeHostContext } from "@vite-hub/runtime"

/** Structural event input shared by H3 1 and H3 2. */
export interface H3RuntimeEvent {
  context: object
  req?: unknown
}

type H3RuntimeName = "cloudflare-agents" | "deno" | "unknown" | "vercel" | "vite"

export type H3RuntimeContextOptions = Omit<RuntimeContextInput, "event" | "runtime"> & {
  runtime?: H3RuntimeName
}

export type H3RuntimeContext<TOptions extends H3RuntimeContextOptions = {}> = CreatedRuntimeContext<
  TOptions & {
    cloudflare?: RuntimeHostContext["cloudflare"]
    event: H3RuntimeEvent
    request?: Request
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

function isRequest(value: unknown): value is Request {
  try {
    if (value instanceof Request) return true
    if (value === null || typeof value !== "object") return false

    // Foreign realms have their own Fetch accessors. Locate the prototype
    // that owns them and invoke those accessors for their Web IDL brand check.
    // Requiring its own Request constructor prevents arbitrary inherited
    // getter objects from being treated as requests.
    let prototype: object | null = value
    while ((prototype = Object.getPrototypeOf(prototype)) !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      if (typeof constructor !== "function" || constructor.name !== "Request" || constructor.prototype !== prototype) continue
      const get = (key: string) => Object.getOwnPropertyDescriptor(prototype, key)?.get
      const headersGetter = get("headers")
      const urlGetter = get("url")
      const methodGetter = get("method")
      const bodyUsedGetter = get("bodyUsed")
      const signalGetter = get("signal")
      const methodNames = ["clone", "arrayBuffer", "blob", "formData", "json", "text"]
      const methods = methodNames.map(key => Object.getOwnPropertyDescriptor(prototype, key)?.value)
      if (![headersGetter, urlGetter, methodGetter, bodyUsedGetter, signalGetter].every(getter => typeof getter === "function")) continue
      if (!methods.every(method => typeof method === "function")) continue
      const headers = headersGetter.call(value)
      urlGetter.call(value)
      methodGetter.call(value)
      bodyUsedGetter.call(value)
      signalGetter.call(value)
      let headersPrototype: object | null = headers
      let headersGet: unknown
      while ((headersPrototype = Object.getPrototypeOf(headersPrototype)) !== null) {
        const constructor = Object.getOwnPropertyDescriptor(headersPrototype, "constructor")?.value
        const descriptor = Object.getOwnPropertyDescriptor(headersPrototype, "get")
        if (typeof constructor === "function" && constructor.name === "Headers"
          && constructor.prototype === headersPrototype && typeof descriptor?.value === "function") {
          headersGet = descriptor.value
          break
        }
      }
      if (typeof headersGet !== "function") continue
      headersGet.call(headers, "x-vite-hub-request-check")
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Adapt one H3 operation. Await flushWaitUntil when the host has no lifetime API. */
export function getRuntimeContext(event: H3RuntimeEvent): H3RuntimeContext
export function getRuntimeContext<const TOptions extends H3RuntimeContextOptions>(
  event: H3RuntimeEvent,
  options: TOptions,
): H3RuntimeContext<TOptions>
export function getRuntimeContext(
  event: H3RuntimeEvent,
  options: H3RuntimeContextOptions = {},
): H3RuntimeContext<H3RuntimeContextOptions> {
  const env = getCloudflareEnv(event, { fallback: false })
  const waitUntil = options.waitUntil?.bind(options)
    ?? options.vercel?.waitUntil?.bind(options.vercel)
    ?? resolveWaitUntil(event, { preferHost: true })
  const cloudflare = options.cloudflare ?? (env ? { env } : undefined)
  const runtime = options.runtime ?? detectRuntime(!!cloudflare)
  return createRuntimeContext({
    ...(isRequest(event.req) ? { request: event.req } : {}),
    ...options,
    ...(cloudflare ? { cloudflare } : {}),
    event,
    runtime,
    ...(runtime === "vercel" && waitUntil ? { vercel: { waitUntil } } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  })
}
