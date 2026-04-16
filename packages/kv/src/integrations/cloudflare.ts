import type { ResolvedKVModuleOptions } from "../types.ts"

interface CloudflareWranglerKVNamespace {
  binding: string
  id: string
}

interface CloudflareIntegrationTarget {
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: CloudflareWranglerKVNamespace[]
    }
  }
}

export function configureCloudflareKV(
  target: CloudflareIntegrationTarget,
  config: ResolvedKVModuleOptions,
): void {
  if (config.store.driver !== "cloudflare-kv-binding" || !config.store.namespaceId) {
    return
  }

  const binding = config.store.binding
  const namespaceId = config.store.namespaceId

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.kv_namespaces ||= []

  if (target.cloudflare.wrangler.kv_namespaces.some(entry => entry.binding === binding)) {
    return
  }

  target.cloudflare.wrangler.kv_namespaces.push({ binding, id: namespaceId })
}
