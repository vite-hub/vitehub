import type { ResolvedBlobModuleOptions } from "../types.ts"

interface CloudflareR2Target {
  cloudflare?: {
    wrangler?: {
      r2_buckets?: Array<{ binding: string, bucket_name?: string }>
    }
  }
}

export function configureCloudflareR2(
  target: CloudflareR2Target,
  config: ResolvedBlobModuleOptions,
): void {
  for (const store of Object.values(config.stores || { default: config.store })) {
    if (store.driver !== "cloudflare-r2" || !store.bucketName) continue

    const { binding, bucketName } = store

    target.cloudflare ||= {}
    target.cloudflare.wrangler ||= {}
    const buckets = (target.cloudflare.wrangler.r2_buckets ||= [])

    if (buckets.some(b => b.binding === binding)) continue
    buckets.push({ binding, bucket_name: bucketName })
  }
}
