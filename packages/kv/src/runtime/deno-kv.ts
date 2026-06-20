import type { Driver } from "unstorage"

import type { ResolvedDenoKVStoreConfig } from "../types.ts"

type DenoKVKey = [unknown, ...unknown[]]
type ViteHubDenoKVKey = [string]

interface DenoKVEntry<T = unknown> {
  key: DenoKVKey
  value: T | null
}

interface DenoKV {
  close?: () => void
  delete: (key: DenoKVKey) => Promise<void>
  get: <T = unknown>(key: DenoKVKey) => Promise<DenoKVEntry<T>>
  list: <T = unknown>(selector: { prefix: [] }) => AsyncIterable<DenoKVEntry<T>>
  set: <T = unknown>(key: DenoKVKey, value: T) => Promise<unknown>
}

interface DenoRuntime {
  openKv?: (path?: string) => Promise<DenoKV>
}

function getDenoRuntime(): DenoRuntime | undefined {
  return (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno
}

function toDenoKey(key: string): ViteHubDenoKVKey {
  return [key]
}

function fromDenoKey(key: DenoKVKey): string | undefined {
  return key.length === 1 && typeof key[0] === "string" ? key[0] : undefined
}

export default function createDenoKVDriver(options: ResolvedDenoKVStoreConfig = { driver: "deno-kv" }): Driver {
  let kvPromise: Promise<DenoKV> | undefined

  const open = () => kvPromise ||= (async () => {
    const openKv = getDenoRuntime()?.openKv
    if (!openKv) {
      throw new Error("[vitehub] Deno KV requires Deno.openKv(). Run in Deno with KV enabled or choose another KV Store driver.")
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
    async getKeys(base = "") {
      return (await matchingKeys(base)).flatMap(key => fromDenoKey(key) ?? []).sort()
    },
    async hasItem(key) {
      return (await (await open()).get(toDenoKey(key))).value !== null
    },
    async removeItem(key) {
      await (await open()).delete(toDenoKey(key))
    },
    async setItem(key, value) {
      await (await open()).set(toDenoKey(key), value)
    },
  }
}
