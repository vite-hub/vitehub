import { getQueueRuntimeEvent } from "./runtime/state.ts"

function readHeader(headers: Headers | Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return
  }

  if (isHeadersLike(headers)) {
    try {
      const descriptor = getPrototypeDescriptor(headers, "get")
      if (!isBrandedMethod(descriptor?.value, headers, name)) return
      const value = descriptor.value.call(headers, name)
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
    const descriptor = getPrototypeDescriptor(value, "get")
    if (!isBrandedMethod(descriptor?.value, value, "ce-vqsregion")) return false
    const result = descriptor.value.call(value, "ce-vqsregion")
    if (result !== undefined && result !== null && typeof result !== "string") return false
    return true
  }
  catch {
    return false
  }
}

function isBrandedMethod(value: unknown, receiver: object, ...args: unknown[]): value is (this: unknown, ...args: unknown[]) => unknown {
  if (typeof value !== "function") return false
  try {
    // Web IDL methods are callable objects without an own prototype. Reject
    // ordinary functions (and proxies around them) before probing the receiver.
    if (Object.prototype.hasOwnProperty.call(value, "prototype")) return false
    const source = Function.prototype.toString.call(value)
    if (!/\[native code\]|(?:webidl\.)?brandCheck\s*\(/.test(source)) return false
    // Exercise the method with a fresh instance from the same realm. Genuine
    // Web IDL methods return the missing-header value for an unknown name;
    // this rejects proxies that only throw for an unrelated probe receiver
    // and return an attacker-controlled value for the real object.
    const prototype = Object.getPrototypeOf(receiver)
    const constructor = prototype && (Object.getOwnPropertyDescriptor(prototype, "constructor")?.value as unknown)
    if (typeof constructor === "function") {
      try {
        const sibling = new constructor()
        const siblingResult = value.call(sibling, "__vitehub_brand_probe__")
        if (siblingResult !== undefined && siblingResult !== null) return false
        // Probe a second genuine instance as well. A receiver-sensitive proxy
        // must behave like the real Web IDL method for every branded receiver.
        const secondSibling = new constructor()
        const secondResult = value.call(secondSibling, "__vitehub_brand_probe__")
        if (secondResult !== undefined && secondResult !== null) return false
      }
      catch {
        return false
      }
    }
    const receiverResult = value.call(receiver, "__vitehub_brand_probe__")
    if (receiverResult !== undefined && receiverResult !== null) return false
    // Genuine Web IDL methods reject an unrelated receiver. This also rejects
    // a Proxy around an ordinary function whose source is reported as native.
    value.call(Object.create(null), ...args)
    return false
  }
  catch {
    return true
  }
}

function getRequestHeaders(value: unknown) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    const descriptor = getPrototypeDescriptor(value, "headers")
    const headers = typeof descriptor?.get === "function" ? descriptor.get.call(value) : undefined
    return isHeadersLike(headers) ? headers : undefined
  }
  catch {
    return undefined
  }
}

function getPrototypeDescriptor(value: object, property: PropertyKey) {
  let prototype: object | null = value
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    if (descriptor) return descriptor
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
