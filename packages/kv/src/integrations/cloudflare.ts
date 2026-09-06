import { pushUnique } from "@vite-hub/internal/arrays"

import type { ResolvedKVModuleOptions } from "../types.ts"

interface CloudflareKVTarget {
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{ binding: string, id?: string }>
    }
  }
}

export function configureCloudflareKV(
  target: CloudflareKVTarget,
  config: ResolvedKVModuleOptions,
): void {
  for (const store of Object.values(config.stores || { default: config.store })) {
    if (store.driver !== "cloudflare-kv-binding") continue

    const { binding, namespaceId } = store

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
