import { getQueueRuntimeEvent } from "./runtime/state.ts"

function readHeader(headers: Headers | Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return
  }

  if (isHeadersLike(headers)) {
    try {
      return Headers.prototype.get.call(headers, name) || undefined
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
    Headers.prototype.get.call(value, "")
    return true
  }
  catch {
    return false
  }
}

function getRequestHeaders(value: unknown) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    const headers = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get?.call(value)
    return isHeadersLike(headers) ? headers : undefined
  }
  catch {
    return undefined
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
