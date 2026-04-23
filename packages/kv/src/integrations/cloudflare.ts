import { pushUnique } from "@vitehub/internal/arrays"

import type { NitroOptions } from "nitro/types"
import type { ResolvedKVModuleOptions } from "../types.ts"

export function configureCloudflareKV(
  target: Pick<NitroOptions, "cloudflare">,
  config: ResolvedKVModuleOptions,
): void {
  if (config.store.driver !== "cloudflare-kv-binding" || !config.store.namespaceId) return

  const { binding, namespaceId } = config.store

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.kv_namespaces ||= []

  pushUnique(
    target.cloudflare.wrangler.kv_namespaces,
    { binding, id: namespaceId },
    entry => entry.binding,
  )
}
