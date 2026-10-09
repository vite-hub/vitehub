import { isPlainObject } from "@vite-hub/internal/object"

import type { DeploymentPreset } from "./index.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** Storage for Nitro's `cache` mount, used by `defineCachedFunction()` and `defineCachedEventHandler()`. */
export type CacheOptions =
  | { driver: "cloudflare-kv-binding", binding?: string, namespaceId?: string }
  | { driver: "deno-kv", base?: string }
  | { driver: "fs-lite", base?: string }
  | { driver: "vercel-runtime-cache" }

type CacheDriver = CacheOptions["driver"]

export interface ResolvedCacheStorage {
  /** Nitro `storage.cache` mount for production output. */
  storage: CacheOptions
  /** Nitro `devStorage.cache` mount. Development keeps cache entries on the local filesystem. */
  devStorage: { driver: "fs-lite", base: string }
  /** Wrangler KV namespace that backs the Cloudflare mount. */
  cloudflareNamespace?: { binding: string, id?: string }
}

export const defaultCacheBase = ".vitehub/data/cache"
const defaultCloudflareCacheBinding = "CACHE"

// Each driver needs a runtime that only one preset provides.
const cacheDriverPresets: Record<CacheDriver, DeploymentPreset> = {
  "cloudflare-kv-binding": "cloudflare",
  "deno-kv": "deno",
  "fs-lite": "node",
  "vercel-runtime-cache": "vercel",
}

const presetCacheDrivers: Partial<Record<DeploymentPreset, CacheDriver>> = {
  cloudflare: "cloudflare-kv-binding",
  deno: "deno-kv",
  node: "fs-lite",
  vercel: "vercel-runtime-cache",
}

function trimmed(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cache options come from user config, so optional strings are checked at runtime.
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isCacheDriver(value: unknown): value is CacheDriver {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The driver literal comes from user config and is checked before use.
  return typeof value === "string" && value in cacheDriverPresets
}

function readCacheDriver(cache: true | CacheOptions, preset: DeploymentPreset): CacheDriver {
  if (cache === true) {
    const driver = presetCacheDrivers[preset]
    if (!driver) {
      throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] \`cache: true\` has no default store for the ${preset} preset. Remove \`cache\` or use a preset that provides one.` })
    }
    return driver
  }
  if (!isPlainObject(cache) || !isCacheDriver(cache.driver)) {
    throw viteHubErrorDiagnostics.VITE_HUB_C0004({ message: `[vitehub] \`cache.driver\` must be "cloudflare-kv-binding", "deno-kv", "fs-lite", or "vercel-runtime-cache".` })
  }
  if (cacheDriverPresets[cache.driver] !== preset) {
    throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] \`cache.driver: "${cache.driver}"\` requires the ${cacheDriverPresets[cache.driver]} preset, but the preset is ${preset}.` })
  }
  return cache.driver
}

/** Resolve `cache` into Nitro storage mounts for one deployment preset. */
export function resolveCacheStorage(cache: true | CacheOptions, preset: DeploymentPreset): ResolvedCacheStorage {
  const driver = readCacheDriver(cache, preset)
  const explicit = cache === true ? undefined : cache
  const localBase = explicit?.driver === "fs-lite" ? trimmed(explicit.base) ?? defaultCacheBase : defaultCacheBase
  const devStorage = { driver: "fs-lite" as const, base: localBase }

  switch (driver) {
    case "cloudflare-kv-binding": {
      const binding = (explicit?.driver === driver ? trimmed(explicit.binding) : undefined) ?? defaultCloudflareCacheBinding
      const id = explicit?.driver === driver ? trimmed(explicit.namespaceId) : undefined
      return {
        cloudflareNamespace: id ? { binding, id } : { binding },
        devStorage,
        storage: { binding, driver },
      }
    }
    case "deno-kv":
      return { devStorage, storage: { base: (explicit?.driver === driver ? trimmed(explicit.base) : undefined) ?? "cache", driver } }
    case "fs-lite":
      return { devStorage, storage: { base: localBase, driver } }
    case "vercel-runtime-cache":
      return { devStorage, storage: { driver } }
  }
}

/** Add the cache mounts to a Nitro config without replacing a `cache` mount that the application set. */
export function applyCacheStorage(nitro: Record<string, unknown>, cache: ResolvedCacheStorage): Record<string, unknown> {
  const storage = isPlainObject(nitro.storage) ? { ...nitro.storage } : {}
  const devStorage = isPlainObject(nitro.devStorage) ? { ...nitro.devStorage } : {}
  storage.cache ??= cache.storage
  devStorage.cache ??= cache.devStorage
  const next: Record<string, unknown> = { ...nitro, devStorage, storage }
  const namespace = cache.cloudflareNamespace
  if (!namespace || storage.cache !== cache.storage) return next

  const cloudflare = isPlainObject(nitro.cloudflare) ? { ...nitro.cloudflare } : {}
  const wrangler = isPlainObject(cloudflare.wrangler) ? { ...cloudflare.wrangler } : {}
  const namespaces = Array.isArray(wrangler.kv_namespaces) ? [...wrangler.kv_namespaces] : []
  const existingIndex = namespaces.findIndex(entry => isPlainObject(entry) && entry.binding === namespace.binding)
  const existing = existingIndex === -1 ? undefined : namespaces[existingIndex]
  if (isPlainObject(existing)) {
    if (namespace.id && existing.id && existing.id !== namespace.id) {
      throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] Cloudflare cache binding "${namespace.binding}" already uses namespace "${existing.id}", but cache.namespaceId requests "${namespace.id}".` })
    }
    if (namespace.id && !existing.id) namespaces[existingIndex] = { ...existing, id: namespace.id }
    if (!namespace.id && !existing.id) {
      throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] Cloudflare cache binding "${namespace.binding}" needs a namespace ID. Set cache.namespaceId or configure an existing namespace with an ID.` })
    }
  } else {
    if (!namespace.id) {
      throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] Cloudflare cache binding "${namespace.binding}" needs a namespace ID. Set cache.namespaceId or configure an existing namespace with an ID.` })
    }
    namespaces.push(namespace)
  }
  wrangler.kv_namespaces = namespaces
  cloudflare.wrangler = wrangler
  next.cloudflare = cloudflare
  return next
}
