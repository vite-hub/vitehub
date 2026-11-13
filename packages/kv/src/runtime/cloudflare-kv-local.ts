import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import createCloudflareDriver from "./cloudflare-kv.ts"
import { assertCloudflareKVWrite, installCloudflareKVLimits, validateCloudflareKVBatch } from "./cloudflare-kv-limits.ts"
import createFsLiteKVDriver from "./fs-lite.ts"
import { getItemsOneByOne, setItemsOneByOne } from "./batch.ts"

import type { ResolvedCloudflareKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

/**
 * A Cloudflare KV store in `vite dev`. It uses the binding when the runtime has one, for example on the workerd
 * runner. Otherwise, for example on Nitro's default Node runner, it uses a local `fs-lite` store with the Workers KV limits.
 */
export default function createCloudflareKVLocalDriver(store: ResolvedCloudflareKVStoreConfig & { localBase: string }): KVRuntimeDriver {
  const binding = createCloudflareDriver({ binding: store.binding, namespaceId: store.namespaceId })
  let localPromise: Promise<KVRuntimeDriver> | undefined
  const pick = async () => {
    if (getActiveCloudflareBinding(store.binding)) return binding
    // Binding-backed requests never need the filesystem. Share fallback initialization and retry failures.
    return localPromise ??= createFsLiteKVDriver({ base: store.localBase, driver: "fs-lite" }).then((local) => {
      installCloudflareKVLimits(local)
      return local
    }).catch((error: unknown) => {
      localPromise = undefined
      throw error
    })
  }
  return {
    name: "cloudflare-kv-local",
    validateBatch: validateCloudflareKVBatch,
    options: store,
    clear: async (base, options) => (await pick()).clear?.(base, options),
    async dispose() {
      await Promise.all([binding.dispose?.(), localPromise?.then(local => local.dispose?.())])
    },
    getItem: async (key, options) => (await pick()).getItem(key, options),
    async getItems(items, options) {
      const driver = await pick()
      return (driver.getItems ?? getItemsOneByOne(driver))(items, options)
    },
    getKeys: async (base, options) => (await pick()).getKeys(base, options),
    hasItem: async (key, options) => (await pick()).hasItem(key, options),
    listKeys: async options => (await pick()).listKeys(options),
    removeItem: async (key, options) => (await pick()).removeItem?.(key, options),
    setItem: async (key, value, options) => (await pick()).setItem?.(key, value, options),
    async setItems(items, options) {
      // Check every entry before any write, as the binding driver does.
      for (const item of items) assertCloudflareKVWrite(item.key, item.value, { ...options, ...item.options })
      const driver = await pick()
      return (driver.setItems ?? setItemsOneByOne(driver))(items, options)
    },
  }
}
