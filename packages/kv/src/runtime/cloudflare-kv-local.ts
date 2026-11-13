import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import createCloudflareDriver from "./cloudflare-kv.ts"
import { installCloudflareKVLimits } from "./cloudflare-kv-limits.ts"
import createFsLiteKVDriver from "./fs-lite.ts"

import type { ResolvedCloudflareKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

/**
 * Seconds until the key expires, as the binding computes them from unstorage's options: `ttl` becomes an
 * `expirationTtl` of at least 60 seconds, and a relative expiration wins over the absolute `expiration`.
 */
function cloudflareExpirationSeconds(options: unknown): number | undefined {
  if (!options || typeof options !== "object") return
  const ttl: unknown = Reflect.get(options, "ttl")
  const put: Record<string, unknown> = { expirationTtl: typeof ttl === "number" && ttl ? Math.max(ttl, 60) : undefined, ...options }
  if (typeof put.expirationTtl === "number") return put.expirationTtl
  if (typeof put.expiration === "number") return put.expiration - Date.now() / 1000
}

/**
 * A Cloudflare KV store in `vite dev`. It uses the binding when the runtime has one, for example on the workerd
 * runner. Otherwise, for example on Nitro's default Node runner, it uses a local `fs-lite` store with the Workers KV limits and expirations.
 */
export default function createCloudflareKVLocalDriver(store: ResolvedCloudflareKVStoreConfig & { localBase: string }): KVRuntimeDriver {
  const binding = createCloudflareDriver({ binding: store.binding, namespaceId: store.namespaceId })
  let localPromise: Promise<KVRuntimeDriver> | undefined
  const pick = async () => {
    if (getActiveCloudflareBinding(store.binding)) return binding
    // Binding-backed requests never need the filesystem. Share fallback initialization and retry failures.
    return localPromise ??= createFsLiteKVDriver({ base: store.localBase, driver: "fs-lite" }).then((local) => {
      const { setItem } = local
      local.setItem = (key, value, options) => setItem?.call(local, key, value, { ttl: cloudflareExpirationSeconds(options) })
      // Installed last, so the limits check the options as the binding gets them.
      installCloudflareKVLimits(local)
      return local
    }).catch((error: unknown) => {
      localPromise = undefined
      throw error
    })
  }
  return {
    name: "cloudflare-kv-local",
    options: store,
    clear: async (base, options) => (await pick()).clear?.(base, options),
    async dispose() {
      await Promise.all([binding.dispose?.(), localPromise?.then(local => local.dispose?.())])
    },
    getItem: async (key, options) => (await pick()).getItem(key, options),
    getKeys: async (base, options) => (await pick()).getKeys(base, options),
    hasItem: async (key, options) => (await pick()).hasItem(key, options),
    listKeys: async options => (await pick()).listKeys(options),
    removeItem: async (key, options) => (await pick()).removeItem?.(key, options),
    setItem: async (key, value, options) => (await pick()).setItem?.(key, value, options),
  }
}
