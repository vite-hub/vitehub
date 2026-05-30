import { pushUnique } from "@vite-hub/internal/arrays"

import type { NitroOptions } from "nitro/types"
import type { ResolvedKVModuleOptions } from "../types.ts"

export function configureCloudflareKV(
  target: Pick<NitroOptions, "cloudflare">,
  config: ResolvedKVModuleOptions,
): void {
  for (const store of Object.values(config.stores || { default: config.store })) {
    if (store.driver !== "cloudflare-kv-binding" || !store.namespaceId) continue

    const { binding, namespaceId } = store

    target.cloudflare ||= {}
    target.cloudflare.wrangler ||= {}
    target.cloudflare.wrangler.kv_namespaces ||= []

    pushUnique(
      target.cloudflare.wrangler.kv_namespaces,
      { binding, id: namespaceId },
      entry => entry.binding,
    )
  }
}
