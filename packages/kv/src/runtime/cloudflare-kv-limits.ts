import type { Driver, TransactionOptions } from "unstorage"

import { kvErrorDiagnostics } from "../error-diagnostics.ts"

// Cloudflare documents these limits at https://developers.cloudflare.com/kv/platform/limits/
// and the minimum expiration at https://developers.cloudflare.com/kv/api/write-key-value-pairs/.
const cloudflareKVLimits = {
  keyBytes: 512,
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
export function assertCloudflareKVWrite(key: string, value: unknown): void {
  assertCloudflareKVKey(key)
  const valueBytes = typeof value === "string" ? bytesAbove(value, cloudflareKVLimits.valueBytes) : undefined
  if (valueBytes !== undefined) throw kvErrorDiagnostics.KV_VALUE_TOO_LARGE({ bytes: valueBytes, limit: cloudflareKVLimits.valueBytes })
}

/** Cloudflare KV rejects an expiration below 60 seconds, so a shorter `ttl` becomes 60 seconds, also on the local store of `vite dev`. */
function cloudflareKVSetOptions(options: TransactionOptions): TransactionOptions {
  const ttl: unknown = options?.ttl
  return typeof ttl === "number" ? { ttl: Math.max(cloudflareKVLimits.minExpirationTtl, ttl) } : options
}

/** Rejects what a Cloudflare KV binding rejects before the driver call, so every store returns the same named code. */
export function installCloudflareKVLimits(driver: Driver): void {
  const { getItem, hasItem, removeItem, setItem } = driver
  driver.getItem = (key, options) => { assertCloudflareKVKey(key); return getItem.call(driver, key, options) }
  driver.hasItem = (key, options) => { assertCloudflareKVKey(key); return hasItem.call(driver, key, options) }
  if (removeItem) driver.removeItem = (key, options) => { assertCloudflareKVKey(key); return removeItem.call(driver, key, options) }
  if (setItem) driver.setItem = (key, value, options) => { assertCloudflareKVWrite(key, value); return setItem.call(driver, key, value, cloudflareKVSetOptions(options)) }
}

/** Preflight serialized writes and deletion keys before either branch starts. */
export function validateCloudflareKVBatch(items: Parameters<NonNullable<Driver["setItems"]>>[0], removals: string[]): void {
  for (const key of removals) assertCloudflareKVKey(key)
  for (const item of items) assertCloudflareKVWrite(item.key, item.value)
}
