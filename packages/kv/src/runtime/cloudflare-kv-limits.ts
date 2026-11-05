import { kvErrorDiagnostics } from "../error-diagnostics.ts"

// Cloudflare documents these limits at https://developers.cloudflare.com/kv/platform/limits/
// and the minimum `expirationTtl` at https://developers.cloudflare.com/kv/api/write-key-value-pairs/.
const cloudflareKVLimits = {
  keyBytes: 512,
  metadataBytes: 1024,
  minExpirationTtl: 60,
  valueBytes: 25 * 1024 * 1024,
} as const

const encoder = /*#__PURE__*/ new TextEncoder()

/** Returns the UTF-8 size of `value` when it is above `limit`. */
function bytesAbove(value: string, limit: number): number | undefined {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so a short string cannot exceed the limit.
  if (value.length * 3 <= limit) return
  const bytes = encoder.encode(value).byteLength
  return bytes > limit ? bytes : undefined
}

export function assertCloudflareKVKey(key: string): void {
  const bytes = bytesAbove(key, cloudflareKVLimits.keyBytes)
  if (bytes !== undefined) throw kvErrorDiagnostics.KV_KEY_TOO_LONG({ bytes, limit: cloudflareKVLimits.keyBytes })
}

/** Checks a `put()` before the binding gets it. `value` is the string that unstorage serialized. */
export function assertCloudflareKVWrite(key: string, value: unknown, options: unknown): void {
  assertCloudflareKVKey(key)
  const valueBytes = typeof value === "string" ? bytesAbove(value, cloudflareKVLimits.valueBytes) : undefined
  if (valueBytes !== undefined) throw kvErrorDiagnostics.KV_VALUE_TOO_LARGE({ bytes: valueBytes, limit: cloudflareKVLimits.valueBytes })
  if (!options || typeof options !== "object") return
  const metadata: unknown = Reflect.get(options, "metadata")
  const metadataJson = metadata === undefined ? undefined : JSON.stringify(metadata)
  const metadataBytes = metadataJson === undefined ? undefined : bytesAbove(metadataJson, cloudflareKVLimits.metadataBytes)
  if (metadataBytes !== undefined) throw kvErrorDiagnostics.KV_METADATA_TOO_LARGE({ bytes: metadataBytes, limit: cloudflareKVLimits.metadataBytes })
  const expirationTtl: unknown = Reflect.get(options, "expirationTtl")
  if (typeof expirationTtl === "number" && expirationTtl < cloudflareKVLimits.minExpirationTtl) {
    throw kvErrorDiagnostics.KV_TTL_TOO_SHORT({ minimum: cloudflareKVLimits.minExpirationTtl, ttl: expirationTtl })
  }
}
