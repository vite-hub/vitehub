import { readEnv } from "@vitehub/internal/env"
import { getActiveCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import { normalizeKVOptions } from "../config.ts"
import type { KVStorage, ResolvedKVModuleOptions } from "../types.ts"
import { createHostedKVStorage, type RuntimeStorage } from "./hosted-storage.ts"

let storagePromise: Promise<RuntimeStorage> | undefined

function inferHosting(env: Record<string, string | undefined>) {
  if (getActiveCloudflareEnv()) {
    return "cloudflare"
  }

  const explicit = readEnv(env, "VITEHUB_HOSTING", "NITRO_PRESET")
  if (explicit) {
    return explicit
  }

  return readEnv(env, "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL") ? "vercel" : undefined
}

function shouldFallbackHostedConfigImport(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || code === "ERR_UNSUPPORTED_ESM_URL_SCHEME"
}

async function resolveHostedConfig(): Promise<false | ResolvedKVModuleOptions | undefined> {
  const virtualConfigId = "virtual:@vitehub/kv/config"

  try {
    const module = await import(
      /* @vite-ignore */
      virtualConfigId
    ) as { kv: false | ResolvedKVModuleOptions }
    return module.kv
  }
  catch (error) {
    if (!shouldFallbackHostedConfigImport(error)) {
      throw error
    }
    const env = typeof process !== "undefined" ? process.env : {}
    return normalizeKVOptions(undefined, { env, hosting: inferHosting(env) }) || false
  }
}

async function resolveStorage() {
  storagePromise ||= import("nitro/storage")
    .then(module => module.useStorage("kv") as RuntimeStorage)
    .catch(async () => {
      const config = await resolveHostedConfig()
      return createHostedKVStorage(config)
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
