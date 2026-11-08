import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"

import createCloudflareDriver from "./cloudflare-kv.ts"
import { installCloudflareKVLimits } from "./cloudflare-kv-limits.ts"
import createFsLiteKVDriver from "./fs-lite.ts"

import type { ResolvedCloudflareKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

/**
 * A Cloudflare KV store in `vite dev`. It uses the binding when the runtime has one, for example on the workerd
 * runner. Otherwise, for example on Nitro's default Node runner, it uses a local `fs-lite` store with the Workers KV limits.
 */
export default function createCloudflareKVLocalDriver(store: ResolvedCloudflareKVStoreConfig & { localBase: string }): KVRuntimeDriver {
  const binding = createCloudflareDriver({ binding: store.binding, namespaceId: store.namespaceId })
  const local = createFsLiteKVDriver({ base: store.localBase, driver: "fs-lite" })
  installCloudflareKVLimits(local)
  const pick = () => getActiveCloudflareBinding(store.binding) ? binding : local
  return {
    name: "cloudflare-kv-local",
    options: store,
    clear: (base, options) => pick().clear?.(base, options),
    async dispose() {
      await Promise.all([binding.dispose?.(), local.dispose?.()])
    },
    getItem: (key, options) => pick().getItem(key, options),
    getKeys: (base, options) => pick().getKeys(base, options),
    hasItem: (key, options) => pick().hasItem(key, options),
    listKeys: options => pick().listKeys(options),
    removeItem: (key, options) => pick().removeItem?.(key, options),
    setItem: (key, value, options) => pick().setItem?.(key, value, options),
  }
}
