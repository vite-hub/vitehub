import type { KVListOptions, ResolvedDenoKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

type DenoKVKey = [unknown, ...unknown[]]
type ViteHubDenoKVKey = [string]
type ViteHubDenoKVExpiryKey = [string, "vitehub:increment-expiry"]

interface DenoKVEntry<T = unknown> {
  key: DenoKVKey
  value: T | null
  versionstamp: string | null
}

interface DenoKV {
  atomic: () => DenoKVAtomicOperation
  close?: () => void
  delete: (key: DenoKVKey) => Promise<void>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models Deno KV's caller-typed get contract.
  get: <T = unknown>(key: DenoKVKey) => Promise<DenoKVEntry<T>>
  list: <T = unknown>(selector: { prefix: [] }, options?: { cursor?: string; limit?: number }) => AsyncIterable<DenoKVEntry<T>> & { cursor?: string }
  set: <T = unknown>(key: DenoKVKey, value: T) => Promise<unknown>
}

interface DenoKVAtomicOperation {
  check: (entry: DenoKVEntry) => DenoKVAtomicOperation
  commit: () => Promise<{ ok: boolean }>
  delete: (key: DenoKVKey) => DenoKVAtomicOperation
  set: <T = unknown>(key: DenoKVKey, value: T, options?: { expireIn?: number }) => DenoKVAtomicOperation
}

interface DenoRuntime {
  openKv?: (path?: string) => Promise<DenoKV>
}

function getDenoRuntime(): DenoRuntime | undefined {
  // SAFETY: The optional global is checked for openKv before invocation.
  return (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno
}

function toDenoKey(key: string): ViteHubDenoKVKey {
  return [key]
}

function toDenoExpiryKey(key: string): ViteHubDenoKVExpiryKey {
  return [key, "vitehub:increment-expiry"]
}

function fromDenoKey(key: DenoKVKey): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Deno KV keys are untrusted structured values and only one-string keys belong to this adapter.
  return key.length === 1 && typeof key[0] === "string" ? key[0] : undefined
}

function normalizeTTL(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError("Atomic KV increment requires a positive TTL in seconds.")
  return Math.ceil(ttl) * 1000
}

function parseCounterValue(value: unknown): number {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Deno KV can contain native numbers or numeric strings written through unstorage.
  if (typeof value !== "number" && typeof value !== "string") return Number.NaN
  return Number(value)
}

export default function createDenoKVDriver(options: ResolvedDenoKVStoreConfig = { driver: "deno-kv" }): KVRuntimeDriver {
  let kvPromise: Promise<DenoKV> | undefined

  const open = () => kvPromise ||= (async () => {
    const openKv = getDenoRuntime()?.openKv
    if (!openKv) {
      throw new Error("[vitehub] Deno KV requires Deno.openKv(). The runtime must be Deno with KV enabled, or the KV Store needs another driver.")
    }
    return openKv(options.path)
  })()

  async function matchingKeys(base = "") {
    const kv = await open()
    const keys: DenoKVKey[] = []

    // ponytail: Deno KV lists structured keys; scan/filter keeps ViteHub string-prefix keys correct.
    for await (const entry of kv.list({ prefix: [] })) {
      const key = fromDenoKey(entry.key)
      if (key?.startsWith(base)) keys.push(entry.key)
    }

    return keys
  }

  async function replaceItem(key: string, replacement?: { value: unknown }): Promise<void> {
    const kv = await open()
    const resolvedKey = toDenoKey(key)
    const expiryKey = toDenoExpiryKey(key)
    while (true) {
      const [entry, expiryEntry] = await Promise.all([kv.get(resolvedKey), kv.get(expiryKey)])
      const transaction = kv.atomic().check(entry).check(expiryEntry).delete(expiryKey)
      if (replacement) transaction.set(resolvedKey, replacement.value)
      else transaction.delete(resolvedKey)
      if ((await transaction.commit()).ok) return
    }
  }

  return {
    name: "deno-kv",
    options,
    async clear(base = "") {
      for (const key of await matchingKeys(base)) {
        const resolvedKey = fromDenoKey(key)
        if (resolvedKey !== undefined) await replaceItem(resolvedKey)
      }
    },
    async dispose() {
      if (!kvPromise) return
      const kv = await kvPromise
      kv.close?.()
      kvPromise = undefined
    },
    async getItem(key) {
      return (await (await open()).get(toDenoKey(key))).value ?? null
    },
    // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors the Deno KV and unstorage caller-typed read contracts.
    async getAndDeleteItem<T = unknown>(key: string): Promise<T | null> {
      const kv = await open()
      const resolvedKey = toDenoKey(key)
      const expiryKey = toDenoExpiryKey(key)
      while (true) {
        const [entry, expiryEntry] = await Promise.all([kv.get<T>(resolvedKey), kv.get(expiryKey)])
        if ((await kv.atomic().check(entry).check(expiryEntry).delete(resolvedKey).delete(expiryKey).commit()).ok) return entry.value ?? null
      }
    },
    async getKeys(base = "") {
      return (await matchingKeys(base)).flatMap(key => fromDenoKey(key) ?? []).sort()
    },
    async listKeys({ cursor, limit, prefix = "" }: KVListOptions) {
      const iterator = (await open()).list({ prefix: [] }, { cursor, limit })
      const keys: string[] = []
      for await (const entry of iterator) {
        const key = fromDenoKey(entry.key)
        if (key?.startsWith(prefix)) keys.push(key)
      }
      return iterator.cursor ? { keys, cursor: iterator.cursor } : { keys }
    },
    async hasItem(key) {
      return (await (await open()).get(toDenoKey(key))).versionstamp !== null
    },
    async incrementItem(key, ttl) {
      const kv = await open()
      const resolvedKey = toDenoKey(key)
      const expiryKey = toDenoExpiryKey(key)
      const expireIn = normalizeTTL(ttl)
      while (true) {
        const [entry, expiryEntry] = await Promise.all([kv.get(resolvedKey), kv.get<number>(expiryKey)])
        const current = entry.versionstamp === null ? 0 : parseCounterValue(entry.value)
        if (!Number.isSafeInteger(current)) throw new TypeError(`Atomic KV increment requires an integer value at "${key}".`)
        const now = Date.now()
        const created = entry.versionstamp === null
        const trackedExpiry = expiryEntry.versionstamp !== null
        const expiresAt = created || !trackedExpiry ? now + expireIn : Number(expiryEntry.value)
        if (!Number.isSafeInteger(expiresAt)) throw new TypeError(`Atomic KV increment has invalid expiry metadata at "${key}".`)
        const remaining = Math.max(1, expiresAt - now)
        const transaction = kv.atomic().check(entry).check(expiryEntry)
        if (!created && !trackedExpiry) {
          const result = await transaction.set(resolvedKey, current + 1).commit()
          if (result.ok) return current + 1
          continue
        }
        const result = await transaction.set(resolvedKey, current + 1, { expireIn: remaining })
          .set(expiryKey, expiresAt, { expireIn: remaining }).commit()
        if (result.ok) return current + 1
      }
    },
    async removeItem(key) {
      await replaceItem(key)
    },
    async setItem(key, value) {
      await replaceItem(key, { value })
    },
  }
}
