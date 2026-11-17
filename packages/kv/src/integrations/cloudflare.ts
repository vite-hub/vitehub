import { readProvisionedId } from "@vite-hub/internal/provision-state"

import type { ProvisionState } from "@vite-hub/internal/provision"
import type { ResolvedKVModuleOptions } from "../types.ts"

interface CloudflareKVTarget {
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{ binding: string, id?: string, remote?: boolean, experimental_remote?: boolean }>
    }
  }
}

// Provision State category for Cloudflare KV namespace ids, keyed by KV Store name.
export const KV_CLOUDFLARE_PROVISION_CATEGORY = "kv"

// A configured namespaceId wins. Otherwise the id recorded by `vitehub provision run` for the store is used.
// Only `vite dev` resolves a store with `remote: true`, so only the dev binding asks Wrangler for the real namespace.
export function configureCloudflareKV(
  target: CloudflareKVTarget,
  config: ResolvedKVModuleOptions,
  provisionState: ProvisionState = {},
): void {
  for (const [storeName, store] of Object.entries(config.stores || { default: config.store })) {
    if (store.driver !== "cloudflare") continue

    const { binding } = store
    const namespaceId = store.namespaceId ?? readProvisionedId(provisionState, "cloudflare", KV_CLOUDFLARE_PROVISION_CATEGORY, storeName)

    target.cloudflare ||= {}
    target.cloudflare.wrangler ||= {}
    target.cloudflare.wrangler.kv_namespaces ||= []

    const namespaces = target.cloudflare.wrangler.kv_namespaces
    const existing = namespaces.find(entry => entry.binding === binding)
    if (existing) {
      // Reconcile both Wrangler spellings as one development policy; builds preserve user fields.
      if (store.remote || store.localBase) {
        delete existing.experimental_remote
        if (store.remote) existing.remote = true
        else delete existing.remote
      }
    }
    else {
      namespaces.push({ binding, ...(namespaceId ? { id: namespaceId } : {}), ...(store.remote ? { remote: true } : {}) })
    }
  }
}
