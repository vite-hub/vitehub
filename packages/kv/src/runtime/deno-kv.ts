import type { KVListOptions, ResolvedDenoKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"

type DenoKVKey = [unknown, ...unknown[]]
type ViteHubDenoKVKey = [string]

interface DenoKVEntry<T = unknown> {
  key: DenoKVKey
  value: T | null
  versionstamp: string | null
}

interface DenoKV {
  close?: () => void
  delete: (key: DenoKVKey) => Promise<void>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models Deno KV's caller-typed get contract.
  get: <T = unknown>(key: DenoKVKey) => Promise<DenoKVEntry<T>>
  list: <T = unknown>(selector: { prefix: [] }, options?: { cursor?: string; limit?: number }) => AsyncIterable<DenoKVEntry<T>> & { cursor?: string }
  set: <T = unknown>(key: DenoKVKey, value: T, options?: { expireIn: number }) => Promise<unknown>
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

function toDenoExpireIn(ttl: unknown): { expireIn: number } | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Match unstorage's TTL normalization at the write-options boundary.
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) return undefined
  const expireIn = Math.max(1, Math.ceil(ttl * 1_000))
  return Number.isSafeInteger(expireIn) ? { expireIn } : undefined
}

export default function createDenoKVDriver(options: ResolvedDenoKVStoreConfig = { driver: "deno-kv" }): KVRuntimeDriver {
  let kvPromise: Promise<DenoKV> | undefined

  function open(): Promise<DenoKV> {
    if (kvPromise) return kvPromise
    const pending = (async () => {
      const openKv = getDenoRuntime()?.openKv
      if (!openKv) {
        throw kvErrorDiagnostics.KV_R0001({ message: "[vitehub] Deno KV requires Deno.openKv(). The runtime must be Deno with KV enabled, or the KV Store needs another driver." })
      }
      return openKv(options.path)
    })()
    kvPromise = pending
    void pending.catch(() => {
      if (kvPromise === pending) kvPromise = undefined
    })
    return pending
  }

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
    async removeItem(key) {
      await (await open()).delete(toDenoKey(key))
    },
    async setItem(key, value, writeOptions) {
      await (await open()).set(toDenoKey(key), value, toDenoExpireIn(writeOptions?.ttl))
    },
  }
}
