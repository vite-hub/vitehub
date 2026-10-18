import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeContext } from "./index.ts"
import type { CreatedRuntimeContext, RuntimeContextInput, RuntimeHostContext } from "./index.ts"

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
    if (value === null || typeof value !== "object") return false
    const nativeGetter = Object.getOwnPropertyDescriptor(Request.prototype, "bodyUsed")?.get
    if (typeof nativeGetter !== "function") return false
    try {
      nativeGetter.call(value)
      return true
    } catch {
      let prototype: object | null = value
      const visited = new Set<object>()
      while (prototype !== null) {
        if (visited.has(prototype)) return false
        visited.add(prototype)
        // Every ordinary class prototype owns its constructor. A proxy that
        // manufactures a new prototype on each step is still bounded by the
        // ceiling above.
        if (prototype !== value
          && !Object.prototype.hasOwnProperty.call(prototype, "constructor")) return false
        if (prototype === Request.prototype) return false
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        // Ordinary class prototypes point their constructor back to themselves.
        // Fresh proxy-created objects do not, so they fail closed immediately.
        if (prototype !== value
          && (typeof constructor !== "function" || constructor.prototype !== prototype)) return false
        const bodyGetter = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")?.get
        if (typeof constructor === "function" && constructor.name === "Request"
          && constructor.prototype === prototype && typeof bodyGetter === "function") {
          // Read the Web IDL tag only after the bounded prototype walk has
          // established a concrete candidate. A proxy can otherwise recurse
          // while resolving Symbol.toStringTag before cycle detection runs.
          if (Object.prototype.toString.call(value) !== "[object Request]") return false
          const findDescriptor = (name: string): PropertyDescriptor | undefined => {
            let current: object | null = prototype
            const seen = new Set<object>()
            while (current !== null) {
              if (seen.has(current)) return undefined
              seen.add(current)
              const descriptor = Object.getOwnPropertyDescriptor(current, name)
              if (descriptor) return descriptor
              current = Object.getPrototypeOf(current)
            }
            return undefined
          }
          const accessorNames = ["body", "headers", "method", "url", "signal"] as const
          const accessors = Object.fromEntries(accessorNames.map(name => [name, findDescriptor(name)])) as Record<typeof accessorNames[number], PropertyDescriptor | undefined>
          if (accessorNames.some(name => typeof accessors[name]?.get !== "function")) return false
          // Request's body operations are part of the host-provided Fetch
          // surface. Requiring the complete method set prevents a plain
          // object from passing solely by imitating a handful of accessors.
          const bodyMethodNames = ["arrayBuffer", "blob", "formData", "json", "text", "clone"] as const
          const methods = Object.fromEntries(bodyMethodNames.map(name => [name, findDescriptor(name)])) as Record<typeof bodyMethodNames[number], PropertyDescriptor | undefined>
          if (bodyMethodNames.some(name => typeof methods[name]?.value !== "function")) return false
          // A foreign Request must not merely inherit this realm's methods on a
          // caller-controlled prototype. Such copied methods brand-check the
          // receiver against this realm's internal slots and identify a spoof,
          // rather than a genuine foreign Request implementation.
          const nativeClone = Object.getOwnPropertyDescriptor(Request.prototype, "clone")?.value
          if (methods.clone?.value === nativeClone) return false
          bodyGetter.call(value)
          const headers = accessors.headers?.get?.call(value)
          const headersPrototype = headers && Object.getPrototypeOf(headers)
          const headersGet = headersPrototype && Object.getOwnPropertyDescriptor(headersPrototype, "get")?.value
          if (typeof headersGet !== "function") return false
          headersGet.call(headers, "x-vite-hub-brand")
          return true
        }
        // A proxy can manufacture a fresh prototype on every lookup. Ordinary
        // class chains are stable, so reject a changing successor before the
        // walk can become unbounded without imposing a depth limit.
        const nextPrototype = Object.getPrototypeOf(prototype)
        prototype = nextPrototype
      }
      return false
    }
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
