import { getQueueRuntimeEvent } from "./runtime/state.ts"

function readHeader(headers: Headers | Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return
  }

  if (isHeadersLike(headers)) {
    try {
      const descriptor = getPrototypeDescriptor(headers, "get")
      if (!descriptor) return
      const result = isBrandedMethod(descriptor.value, headers, descriptor.owner, undefined, "probe")
      if (!result.ok) return
      const value = descriptor.value.call(headers, name)
      const confirmed = descriptor.value.call(headers, name)
      if (value !== confirmed) return
      return typeof value === "string" && value ? value : undefined
    }
    catch {
      return
    }
  }

  let value: unknown
  try {
    value = headers[name] ?? headers[name.toLowerCase()]
  }
  catch {
    return
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host headers are untyped; accept only string values before parsing the region.
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Repeated host headers use the first value only when it is a string.
    return typeof value[0] === "string" ? value[0] : undefined
  }
}

function isHeadersLike(value: unknown): value is Headers {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false
  try {
    // A genuine Headers instance inherits get from its realm's prototype.
    // An own override can be a receiver-sensitive proxy that only looks
    // branded during the probes below and returns an attacker-controlled
    // region for the actual object.
    if (Object.prototype.hasOwnProperty.call(value, "get")) return false
    const descriptor = getPrototypeDescriptor(value, "get")
    if (!descriptor) return false
    const result = isBrandedMethod(descriptor.value, value, descriptor.owner, undefined, "probe")
    return result.ok
  }
  catch {
    return false
  }
}

function isBrandedMethod(value: unknown, receiver: object, owner: object | undefined, targetName?: string, mode: "get" | "probe" | "accessor" = "accessor"): { ok: true, value?: string } | { ok: false } {
  if (typeof value !== "function") return { ok: false }
  try {
    const source = Function.prototype.toString.call(value)
    // Browser Fetch methods stringify as native functions. Node's Undici
    // implementation is a JavaScript wrapper that performs an internal Web
    // IDL brand check; ordinary user-defined methods do neither.
    if (!source.includes("[native code]") && !source.includes("webidl.brandCheck")) return { ok: false }
    if (!owner || Object.getPrototypeOf(owner) === null) return { ok: false }
    const constructor = Object.getOwnPropertyDescriptor(owner, "constructor")?.value
    if (typeof constructor !== "function" || constructor.prototype !== owner || (constructor.name !== "Headers" && constructor.name !== "Request")) return { ok: false }
    // `instanceof` uses the candidate realm's constructor and therefore works
    // across realms while rejecting objects that merely advertise Web IDL tags.
    if (!(receiver instanceof constructor)) return { ok: false }
    // A valid header name keeps the probe on the native Web IDL path. Accept
    // either a missing header or its string value so callers can legitimately
    // provide this name themselves; the probe must not depend on a header
    // being absent.
    if (mode === "accessor") {
      value.call(receiver)
      return { ok: true }
    }
    const probeName = targetName ?? "x-vitehub-brand-probe"
    const probe = value.call(receiver, probeName)
    if (probe !== null && typeof probe !== "string") return { ok: false }
    return { ok: true, value: typeof probe === "string" && probe ? probe : undefined }
  }
  catch {
    return { ok: false }
  }
}

function getRequestHeaders(value: unknown) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    const descriptor = getPrototypeDescriptor(value, "headers")
    if (!descriptor?.get || !isBrandedMethod(descriptor.get, value, descriptor.owner, undefined, "accessor").ok) return undefined
    const headers = descriptor.get.call(value)
    return isHeadersLike(headers) ? headers : undefined
  }
  catch {
    return undefined
  }
}

function getPrototypeDescriptor(value: object, property: PropertyKey): (PropertyDescriptor & { owner: object }) | undefined {
  let prototype: object | null = value
  const visited = new WeakSet<object>()
  // Allow deep userland subclassing while bounding hostile getPrototypeOf traps
  // that return a fresh object on every step.
  const maxDepth = 1024
  let depth = 0
  // Stop on repeated prototypes so hostile cycles terminate without rejecting deep valid chains.
  while (prototype && depth++ < maxDepth) {
    if (visited.has(prototype)) return undefined
    visited.add(prototype)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    if (descriptor) return { ...descriptor, owner: prototype }
    prototype = Object.getPrototypeOf(prototype)
  }
}

function parseRegionFromVercelId(value: string | undefined) {
  if (!value) {
    return
  }

  const match = value.match(/^([a-z0-9]+)::/i)
  return match?.[1]?.toLowerCase()
}

export function resolveVercelQueueRegion(explicitRegion: string | undefined) {
  if (explicitRegion) {
    return { region: explicitRegion, requestScoped: false }
  }

  if (process.env.QUEUE_REGION) {
    return { region: process.env.QUEUE_REGION, requestScoped: false }
  }

  if (process.env.VERCEL_REGION) {
    return { region: process.env.VERCEL_REGION, requestScoped: false }
  }

  // SAFETY: Queue host integrations supply Fetch or Nitro events; all host-specific header containers are optional and their values are checked below.
  const event = getQueueRuntimeEvent() as { node?: { req?: { headers?: Headers | Record<string, unknown> } }, req?: { headers?: Headers | Record<string, unknown> }, request?: Request } | undefined
  let requestHeaders: Headers | Record<string, unknown> | undefined
  try {
    const request = event?.request
    requestHeaders = getRequestHeaders(request)
  }
  catch {
    requestHeaders = undefined
  }
  if (!requestHeaders) {
    try {
      requestHeaders = event?.req?.headers ?? event?.node?.req?.headers
    }
    catch {
      requestHeaders = undefined
    }
  }

  return {
    region: readHeader(requestHeaders, "ce-vqsregion") || parseRegionFromVercelId(readHeader(requestHeaders, "x-vercel-id")),
    requestScoped: event !== undefined,
  }
}
