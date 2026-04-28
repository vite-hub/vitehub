import { readEnv } from "@vitehub/internal/env"
import { getActiveCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import { normalizeKVOptions } from "../config.ts"
import type { KVStorage } from "../types.ts"
import type { ResolvedKVModuleOptions } from "../types.ts"
import { createHostedKVStorage } from "./hosted-storage.ts"

interface RuntimeStorage {
  clear(base?: string, options?: unknown): Promise<void>
  getItem<T = unknown>(key: string, options?: unknown): Promise<T | null>
  getKeys(base?: string, options?: unknown): Promise<string[]>
  hasItem(key: string, options?: unknown): Promise<boolean>
  removeItem(key: string, options?: unknown): Promise<void>
  setItem<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}

let storagePromise: Promise<RuntimeStorage> | undefined

async function resolveHostedConfig(): Promise<false | ResolvedKVModuleOptions | undefined> {
  const virtualConfigId = "virtual:@vitehub/kv/config"

  try {
    const module = await import(
      /* @vite-ignore */
      virtualConfigId
    ) as { kv: false | ResolvedKVModuleOptions }
    return module.kv
  }
  catch {
    const env = typeof process !== "undefined" ? process.env : {}
    const hosting = getActiveCloudflareEnv()
      ? "cloudflare"
      : readEnv(env, "VITEHUB_HOSTING", "NITRO_PRESET") || (readEnv(env, "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL") ? "vercel" : undefined)
    return normalizeKVOptions(undefined, { env, hosting }) || false
  }
}

async function resolveStorage() {
  storagePromise ||= import("nitro/storage")
    .then(module => module.useStorage("kv") as RuntimeStorage)
    .catch(async () => {
      const config = await resolveHostedConfig()
      return createHostedKVStorage(config) as unknown as RuntimeStorage
    })
  return storagePromise
}

export const kv: KVStorage = {
  async clear(base, options) { await (await resolveStorage()).clear(base, options) },
  async del(key, options) { await (await resolveStorage()).removeItem(key, options) },
  async get(key, options) { return (await resolveStorage()).getItem(key, options) },
  async has(key, options) { return (await resolveStorage()).hasItem(key, options) },
  async keys(base, options) { return (await resolveStorage()).getKeys(base, options) },
  async set(key, value, options) { await (await resolveStorage()).setItem(key, value, options) },
}
