import { getQueueRuntimeEvent } from "./runtime/state.ts"

type HeaderSource = Record<string, unknown>

function readHeader(headers: HeaderSource | undefined, name: string) {
  // Headers from any Fetch implementation have get(). Node request headers are a plain record.
  const get = headers?.get
  const value: unknown = typeof get === "function" ? get.call(headers, name) : headers?.[name]
  if (typeof value === "string") return value || undefined
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
}

function parseRegionFromVercelId(value: string | undefined) {
  return value?.match(/^([a-z0-9]+)::/i)?.[1]?.toLowerCase()
}

export function resolveVercelQueueRegion(explicitRegion: string | undefined) {
  const region = explicitRegion || process.env.QUEUE_REGION || process.env.VERCEL_REGION
  if (region) return { region, requestScoped: false }

  // SAFETY: Queue host integrations supply Fetch or Nitro events; every header container is optional.
  const event = getQueueRuntimeEvent() as { req?: { headers?: HeaderSource }, request?: { headers?: HeaderSource } } | undefined
  const headers = event?.request?.headers ?? event?.req?.headers
  return {
    region: readHeader(headers, "ce-vqsregion") || parseRegionFromVercelId(readHeader(headers, "x-vercel-id")),
    requestScoped: event !== undefined,
  }
}
