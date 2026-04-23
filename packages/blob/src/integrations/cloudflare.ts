import type { NitroOptions } from "nitro/types"
import type { ResolvedBlobModuleOptions } from "../types.ts"

export function configureCloudflareR2(
  target: Pick<NitroOptions, "cloudflare">,
  config: ResolvedBlobModuleOptions,
): void {
  if (config.store.driver !== "cloudflare-r2" || !config.store.bucketName) return

  const { binding, bucketName } = config.store

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  const buckets = (target.cloudflare.wrangler.r2_buckets ||= [])

  if (buckets.some(b => b.binding === binding || b.bucket_name === bucketName)) return
  buckets.push({ binding, bucket_name: bucketName })
}
