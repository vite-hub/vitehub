import { isPlainObject } from "@vite-hub/internal/object"

import type { ViteHubHost } from "./deployment.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** Storage for Nitro's `cache` mount, used by `defineCachedFunction()` and `defineCachedEventHandler()`. */
export type CacheOptions =
  | { driver: "cloudflare-kv-binding", binding?: string, namespaceId?: string }
  /** The app's default KV store, on every host where `kv` is enabled. `base` prefixes the cache keys (default `nitro-cache`). */
  | { driver: "kv", base?: string }
  | { driver: "deno-kv", base?: string }
  | { driver: "fs-lite", base?: string }
  | { driver: "vercel-runtime-cache" }

type CacheDriver = Exclude<CacheOptions["driver"], "kv">

/** `{ driver: "kv" }` mounts the KV package's unstorage driver by file path. It runs over `kv` from `vite-hub/kv`. */
type KVCacheMount = { driver: string, base: string }

export interface ResolvedCacheStorage {
  /** Nitro cache mount for production output. */
  storage: Exclude<CacheOptions, { driver: "kv" }> | KVCacheMount
  /** Development and prerendering use the local filesystem, or the app's dev KV store. */
  devStorage: { driver: "fs-lite", base: string } | KVCacheMount
  /** Wrangler KV namespace that backs the Cloudflare mount. */
  cloudflareNamespace?: { binding: string, id?: string }
}

const defaultCacheBase = ".vitehub/data/cache"
const defaultCloudflareCacheBinding = "CACHE"

// Each driver needs a runtime that only one host provides.
const cacheDriverHosts: Record<CacheDriver, ViteHubHost> = {
  "cloudflare-kv-binding": "cloudflare",
  "deno-kv": "deno",
  "fs-lite": "node",
  "vercel-runtime-cache": "vercel",
}

const hostCacheDrivers: Partial<Record<ViteHubHost, CacheDriver>> = {
  cloudflare: "cloudflare-kv-binding",
  deno: "deno-kv",
  node: "fs-lite",
  vercel: "vercel-runtime-cache",
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isCacheDriver(value: unknown): value is CacheDriver {
  return typeof value === "string" && Object.hasOwn(cacheDriverHosts, value)
}

function readCacheDriver(cache: true | CacheOptions, host: ViteHubHost): CacheDriver {
  if (cache === true) {
    const driver = hostCacheDrivers[host]
    if (!driver) {
      throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] \`cache: true\` has no default store for the ${host} host. Remove \`cache\` or use a host that provides one.` })
    }
    return driver
  }
  if (!isPlainObject(cache) || !isCacheDriver(cache.driver)) {
    throw viteHubErrorDiagnostics.VITE_HUB_C0004({ message: `[vitehub] \`cache.driver\` must be "cloudflare-kv-binding", "deno-kv", "fs-lite", "kv", or "vercel-runtime-cache".` })
  }
  if (cacheDriverHosts[cache.driver] !== host) {
    throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: `[vitehub] \`cache.driver: "${cache.driver}"\` requires the ${cacheDriverHosts[cache.driver]} host, but the host is ${host}.` })
  }
  return cache.driver
}

/** Resolve `cache` into Nitro storage mounts for one host. */
export function resolveCacheStorage(cache: true | CacheOptions, host: ViteHubHost, kvCacheDriver?: string): ResolvedCacheStorage {
  // KV runs on every host, so this driver needs `kv` instead of a host.
  if (isPlainObject(cache) && cache.driver === "kv") {
    if (!kvCacheDriver) throw viteHubErrorDiagnostics.VITE_HUB_C0003({ message: "[vitehub] `cache.driver: \"kv\"` stores Nitro's cache in KV, but `kv` is not enabled. Enable `kv` or choose another cache driver." })
    const mount: KVCacheMount = { base: trimmed(cache.base) ?? "nitro-cache", driver: kvCacheDriver }
    return { devStorage: mount, storage: mount }
  }
  const driver = readCacheDriver(cache, host)
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
  const storage = isPlainObject(nitro.kv) ? { ...nitro.kv } : {}
  // Nitro 3 still reads the deprecated `storage` option, so keep a `cache` mount that the application set there.
  storage.cache ??= isPlainObject(nitro.storage) ? nitro.storage.cache : undefined
  storage.cache ??= cache.storage
  const next: Record<string, unknown> = { ...nitro, kv: storage }
  for (const environment of ["$development", "$prerender"]) {
    const config = isPlainObject(nitro[environment]) ? { ...nitro[environment] } : {}
    const kv = isPlainObject(config.kv) ? { ...config.kv } : {}
    kv.cache ??= cache.devStorage
    next[environment] = { ...config, kv }
  }
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
