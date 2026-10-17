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
    if (Object.prototype.toString.call(value) !== "[object Request]") return false
    // A native accessor performs the Request internal-slot check without
    // consulting properties supplied by the candidate. This covers the
    // current realm directly.
    const bodyUsedGetter = Object.getOwnPropertyDescriptor(Request.prototype, "bodyUsed")?.get
    if (typeof bodyUsedGetter !== "function") return false
    try {
      bodyUsedGetter.call(value)
      return true
    } catch {
      // Fetch implementations in another realm have their own accessors.
      // Locate that realm's genuine Request prototype and use its native
      // bodyUsed getter; copied methods on a forged prototype still fail the
      // internal-slot check.
      const seen = new Set<object>()
      let branded = false
      let valid = true
      let reachedObjectPrototype = false
      let prototype: object | null = value
      while (prototype !== null) {
        if (seen.has(prototype)) return false
        seen.add(prototype)
        // A foreign Request prototype must not be layered over this realm's
        // Request prototype. Such a chain can copy native methods onto a
        // forged object while the receiver still lacks the foreign slots.
        if (prototype === Request.prototype) return false
        const objectConstructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        if (typeof objectConstructor === "function" && objectConstructor.name === "Object" && objectConstructor.prototype === prototype) {
          reachedObjectPrototype = true
        }
        const constructor = objectConstructor
        const getter = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")?.get
        if (typeof constructor === "function" && constructor.name === "Request"
          && constructor.prototype === prototype && typeof getter === "function") {
          try {
            const prototypeDescriptor = Object.getOwnPropertyDescriptor(constructor, "prototype")
            if (!prototypeDescriptor || prototypeDescriptor.writable || prototypeDescriptor.configurable) {
              valid = false
            } else {
              // Validate that this constructor and accessor belong together.
              const probe = new constructor("https://example.test")
              if (Object.getPrototypeOf(probe) !== prototype) {
                valid = false
              } else {
                // A genuine Web IDL accessor must reject an unrelated
                // receiver. This guards against a caller-supplied getter
                // that simply returns a boolean while its headers getter
                // returns a genuine Headers instance.
                // Check the complete set of Request accessors from this
                // prototype. Every native Web IDL accessor rejects an
                // unrelated receiver; checking several prevents a forged
                // bodyUsed-only prototype from being accepted.
                const accessors = ["bodyUsed", "headers", "url", "method"] as const
                for (const name of accessors) {
                  const accessor = Object.getOwnPropertyDescriptor(prototype, name)?.get
                  if (typeof accessor !== "function") {
                    valid = false
                    break
                  }
                  try {
                    // Web IDL accessors must reject an unrelated receiver,
                    // then accept both a request constructed by that realm
                    // and the candidate itself. Keep every invocation inside
                    // the guard: copied native accessors throw for forged
                    // receivers and must be treated as a normal rejection.
                    accessor.call({})
                    valid = false
                    break
                  } catch {
                    try {
                      accessor.call(probe)
                      accessor.call(value)
                    } catch {
                      valid = false
                      break
                    }
                  }
                }
                if (valid) {
                  const headers = Object.getOwnPropertyDescriptor(prototype, "headers")?.get?.call(value)
                  const headersPrototype = headers && Object.getPrototypeOf(headers)
                  const headersGet = headersPrototype && Object.getOwnPropertyDescriptor(headersPrototype, "get")?.value
                  if (typeof headersGet !== "function") {
                    valid = false
                  } else {
                    headersGet.call(headers, "x-vite-hub-brand")
                    branded = true
                  }
                }
              }
            }
          } catch {
            // Every Request prototype in the chain must accept the receiver.
            // This rejects a forged accessor layered over a native prototype.
            valid = false
          }
        }
        prototype = Object.getPrototypeOf(prototype)
      }
      return branded && valid && reachedObjectPrototype
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
