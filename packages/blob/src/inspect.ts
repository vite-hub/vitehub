import { resolveBlobViteConfig } from "./vite-config.ts"

import type { ViteHubResourceSummary } from "@vite-hub/internal/inspect"
import type { BlobModuleOptions } from "./types.ts"

/**
 * Lists the R2 buckets and the Vercel Blob store that Blob stores use. Reads local config only.
 * R2 binds a bucket by name. Vercel Blob names the store connected to the project with `BLOB_STORE_ID`, or reaches it through `BLOB_READ_WRITE_TOKEN`.
 */
export function inspectBlobResources(
  options: BlobModuleOptions | undefined,
  input: { env?: Record<string, string | undefined>, hosting?: string } = {},
): ViteHubResourceSummary[] {
  const env = input.env ?? process.env
  // `hosting` is the host that `hubBlob()` resolved, for example from a Cloudflare `nitro.preset`.
  const config = resolveBlobViteConfig(options, { env, hosting: input.hosting })
  if (config.blob === false) return []
  const resources: ViteHubResourceSummary[] = []
  for (const [storeName, store] of Object.entries(config.blob.stores ?? { default: config.blob.store })) {
    if (store.driver === "cloudflare-r2") {
      resources.push({
        binding: store.binding,
        definition: storeName,
        host: "cloudflare",
        kind: "cloudflare-r2-bucket",
        owner: "blob",
        ...(store.bucketName
          ? { name: store.jurisdiction ? `${store.bucketName} (${store.jurisdiction})` : store.bucketName, source: "name" }
          : { note: "No bucket name. Set `bucketName` or `BLOB_BUCKET_NAME`." }),
      })
    }
    else if (store.driver === "vercel-blob") {
      resources.push({
        definition: storeName,
        host: "vercel",
        kind: "vercel-blob-store",
        owner: "blob",
        ...(env.BLOB_STORE_ID
          ? { env: "BLOB_STORE_ID", id: env.BLOB_STORE_ID, source: "env" }
          : env.BLOB_READ_WRITE_TOKEN
            ? { env: "BLOB_READ_WRITE_TOKEN", source: "env" }
            : { note: "Vercel sets `BLOB_STORE_ID` for the store that is connected to the project. Off Vercel, set `BLOB_READ_WRITE_TOKEN`." }),
      })
    }
  }
  return resources
}
