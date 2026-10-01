import { pushUnique } from "@vite-hub/internal/arrays"
import { readProvisionedId } from "@vite-hub/internal/provision-state"

import type { ProvisionState } from "@vite-hub/internal/provision"
import type { ResolvedKVModuleOptions } from "../types.ts"

interface CloudflareKVTarget {
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{ binding: string, id?: string }>
    }
  }
}

// Provision State category for Cloudflare KV namespace ids, keyed by KV Store name.
export const KV_CLOUDFLARE_PROVISION_CATEGORY = "kv"

// A configured namespaceId wins. Otherwise the id recorded by `vitehub provision run` for the store is used.
export function configureCloudflareKV(
  target: CloudflareKVTarget,
  config: ResolvedKVModuleOptions,
  provisionState: ProvisionState = {},
): void {
  for (const [storeName, store] of Object.entries(config.stores || { default: config.store })) {
    if (store.driver !== "cloudflare-kv-binding") continue

    const { binding } = store
    const namespaceId = store.namespaceId ?? readProvisionedId(provisionState, "cloudflare", KV_CLOUDFLARE_PROVISION_CATEGORY, storeName)

    target.cloudflare ||= {}
    target.cloudflare.wrangler ||= {}
    target.cloudflare.wrangler.kv_namespaces ||= []

    pushUnique(
      target.cloudflare.wrangler.kv_namespaces,
      { binding, ...(namespaceId ? { id: namespaceId } : {}) },
      entry => entry.binding,
    )
  }
}
