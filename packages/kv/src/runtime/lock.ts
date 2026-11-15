import type { Result } from "@vite-hub/runtime"

import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { kvResult } from "../errors.ts"
import type { KVLock, KVLockAcquisition, KVLockErrorCode, KVLockOptions } from "../types.ts"
import type { RuntimeStorage } from "./hosted-storage.ts"

const firstRetryMs = 25
const maxRetryMs = 500

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function validTtl(ttl: number): boolean {
  return Number.isFinite(ttl) && ttl > 0 && Number.isSafeInteger(Math.ceil(ttl * 1000))
}

/**
 * A lock on `key` built on `setIfAbsent()` with a TTL and `deleteIfEquals()`. Each acquire writes a new random owner
 * token, and the release deletes the key only when it still holds that token.
 */
export function createKVLock(store: string, resolveStorage: () => Promise<RuntimeStorage>, key: string, options: KVLockOptions): KVLock {
  async function acquire(): Promise<Result<KVLockAcquisition, KVLockErrorCode>> {
    const { ttl } = options
    const wait = options.wait ?? 0
    if (!validTtl(ttl)) return [kvErrorDiagnostics.KV_INVALID_TTL(), undefined]
    if (!Number.isFinite(wait) || wait < 0) return [kvErrorDiagnostics.KV_INVALID_WAIT(), undefined]
    // Config errors, for example an unknown store, throw as they do for the other KV operations.
    const storage = await resolveStorage()
    return kvResult("lock", store, async (): Promise<KVLockAcquisition> => {
      const claim = storage.setIfAbsentItem
      const free = storage.deleteIfEqualsItem
      if (!claim || !free) throw kvErrorDiagnostics.KV_UNSUPPORTED_OPERATION({ operation: "lock", store })
      const owner = globalThis.crypto.randomUUID()
      const deadline = performance.now() + wait * 1000
      let delay = firstRetryMs
      while (true) {
        const started = performance.now()
        if (await claim(key, owner, ttl)) {
          // Count the entire provider round trip against the lease, including response latency.
          if (performance.now() - started < ttl * 1000) {
            return { acquired: true, release: () => kvResult("lock", store, () => free(key, owner)) }
          }
          await free(key, owner)
          return { acquired: false }
        }
        const left = deadline - performance.now()
        if (left <= 0) return { acquired: false }
        // Jitter keeps waiting runners from polling the store at the same moment.
        await sleep(Math.min(left, delay / 2 + Math.random() * delay / 2))
        delay = Math.min(delay * 2, maxRetryMs)
      }
    }, ["KV_UNSUPPORTED_OPERATION"])
  }

  return {
    acquire,
    async run(fn) {
      const [error, lock] = await acquire()
      if (error) return [error, undefined]
      if (!lock.acquired) return [undefined, { acquired: false }]
      let value
      try {
        value = await fn()
      }
      catch (cause) {
        // The callback's error matters more than a failed release. The lock expires after `ttl` anyway.
        await lock.release()
        throw cause
      }
      const [releaseError] = await lock.release()
      if (releaseError) return [releaseError, undefined]
      return [undefined, { acquired: true, value }]
    },
  }
}
