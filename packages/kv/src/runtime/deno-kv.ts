import type { KVListOptions, ResolvedDenoKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

type DenoKVKey = [unknown, ...unknown[]]
type ViteHubDenoKVKey = [string]

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

  return {
    name: "deno-kv",
    options,
    async clear(base = "") {
      const kv = await open()
      for (const key of await matchingKeys(base)) {
        await kv.delete(key)
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
      while (true) {
        const entry = await kv.get<T>(resolvedKey)
        if ((await kv.atomic().check(entry).delete(resolvedKey).commit()).ok) return entry.value ?? null
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
      const expireIn = normalizeTTL(ttl)
      while (true) {
        const entry = await kv.get(resolvedKey)
        const current = entry.versionstamp === null ? 0 : parseCounterValue(entry.value)
        if (!Number.isSafeInteger(current)) throw new TypeError(`Atomic KV increment requires an integer value at "${key}".`)
        const transaction = kv.atomic().check(entry)
        const result = await (entry.versionstamp === null
          ? transaction.set(resolvedKey, current + 1, { expireIn })
          : transaction.set(resolvedKey, current + 1)).commit()
        if (result.ok) return current + 1
      }
    },
    async removeItem(key) {
      await (await open()).delete(toDenoKey(key))
    },
    async setItem(key, value) {
      await (await open()).set(toDenoKey(key), value)
    },
  }
}
