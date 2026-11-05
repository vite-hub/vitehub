import { readProvisionedId, readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { KV_CLOUDFLARE_PROVISION_CATEGORY } from "./integrations/cloudflare.ts"
import { resolveKVViteConfig } from "./vite-config.ts"

import type { ViteHubResourceSummary } from "@vite-hub/internal/inspect"
import type { KVModuleOptions, ResolvedCloudflareKVStoreConfig } from "./types.ts"

function cloudflareStores(options: KVModuleOptions | undefined, env: Record<string, string | undefined>): Map<string, ResolvedCloudflareKVStoreConfig> {
  const stores = new Map<string, ResolvedCloudflareKVStoreConfig>()
  const kv = resolveKVViteConfig(options, { env }).kv
  if (!kv) return stores
  for (const [name, store] of Object.entries(kv.stores || { default: kv.store })) {
    if (store.driver === "cloudflare-kv-binding") stores.set(name, store)
  }
  return stores
}

/** Lists the Workers KV namespaces that KV Stores bind, with where each id comes from. Reads local config and Provision State only. */
export function inspectKVResources(options: KVModuleOptions | undefined, provisionRoot: string, env: Record<string, string | undefined> = process.env): ViteHubResourceSummary[] {
  const stores = cloudflareStores(options, env)
  if (!stores.size) return []
  // `KV_NAMESPACE_ID` fills only a store without a configured id, so resolving without it shows which ids config sets.
  const configured = cloudflareStores(options, { ...env, KV_NAMESPACE_ID: undefined })
  const provisionState = readProvisionStateSync(provisionRoot)
  return [...stores].map(([storeName, store]): ViteHubResourceSummary => {
    const configuredId = configured.get(storeName)?.namespaceId
    const provisionedId = readProvisionedId(provisionState, "cloudflare", KV_CLOUDFLARE_PROVISION_CATEGORY, storeName)
    const id = store.namespaceId ?? provisionedId
    return {
      binding: store.binding,
      definition: storeName,
      host: "cloudflare",
      kind: "cloudflare-kv-namespace",
      ...(store.namespaceName ? { name: store.namespaceName } : {}),
      owner: "kv",
      ...(id ? { id } : {}),
      ...(configuredId ? { source: "config" } : store.namespaceId ? { env: "KV_NAMESPACE_ID", source: "env" } : provisionedId ? { source: "provision-state" } : {}),
    }
  })
}
