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
    if (value === null || typeof value !== "object") return false
    // A native accessor performs the Request internal-slot check without
    // consulting properties supplied by the candidate. This covers the
    // current realm directly, including subclasses, while rejecting objects
    // that merely inherit Request.prototype and copy its methods.
    const bodyUsedGetter = Object.getOwnPropertyDescriptor(Request.prototype, "bodyUsed")?.get
    if (typeof bodyUsedGetter !== "function") return false
    try {
      bodyUsedGetter.call(value)
      return true
    } catch {
      // Fetch implementations in another realm have their own accessors.
      if (Object.prototype.toString.call(value) !== "[object Request]") return false
      let hostRecognized = false
      try {
        new Request(value as Request)
        hostRecognized = true
      } catch {
        // Consumed requests cannot be copied by the constructor. They are
        // validated below with the foreign realm's native accessor.
      }
      // Locate that realm's genuine Request prototype and use its native
      // bodyUsed getter; copied methods on a forged prototype still fail the
      // internal-slot check.
      let branded = false
      let valid = true
      let reachedObjectPrototype = false
      let prototype: object | null = value
      const visited = new Set<object>()
      while (prototype !== null) {
        if (visited.has(prototype)) return false
        visited.add(prototype)
        const objectConstructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        if (typeof objectConstructor === "function" && objectConstructor.name === "Object" && objectConstructor.prototype === prototype) {
          reachedObjectPrototype = true
        }
        const constructor = objectConstructor
        const getter = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")?.get
        if (typeof constructor === "function" && constructor.name === "Request"
          && constructor.prototype === prototype && typeof getter === "function") {
          try {
            // A genuine Web IDL accessor performs its receiver brand check
            // before reading any state. Candidate-owned getters that merely
            // return a Request-shaped value must not be accepted as proof of
            // Request identity.
            try {
              getter.call({})
              valid = false
            } catch {
              // Expected for an unrelated receiver.
            }
            if (!valid) {
              prototype = Object.getPrototypeOf(prototype)
              continue
            }
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
                const currentRealmRequest = new Request("https://example.test")
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
                      // A foreign Request accessor must reject a genuine
                      // current-realm Request as well. Caller-controlled
                      // getters that merely special-case `{}` and their
                      // candidate are rejected by this independent receiver
                      // check before their return values can be trusted.
                      accessor.call(currentRealmRequest)
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
                }
                if (valid) {
                  let candidateBodyUsed: unknown
                  try {
                    candidateBodyUsed = getter.call(value)
                  } catch {
                    valid = false
                  }
                  // A fresh foreign request must be recognized by the host
                  // constructor as well. This independent operation rejects
                  // candidate-controlled accessors that special-case only
                  // the candidate receiver.
                  if (valid && candidateBodyUsed === false && !hostRecognized) valid = false
                }
                if (valid) {
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
        try {
          prototype = Object.getPrototypeOf(prototype)
        } catch {
          return false
        }
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
