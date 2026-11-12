import { readEnv } from "@vite-hub/internal/env"

import { isMaskedBlobRuntimeValue } from "./config.ts"
import { resolveBlobViteConfig } from "./vite-config.ts"

import type { ViteHubResourceSummary } from "@vite-hub/internal/inspect"
import type { BlobOptions } from "./types.ts"

/**
 * Lists the R2 buckets and the Vercel Blob store that Blob stores use. Reads local config only.
 * R2 binds a bucket by name. Vercel Blob uses a configured token, or the project's `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN`.
 */
export function inspectBlobResources(
  options: BlobOptions | undefined,
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
      const storeId = readEnv(env, "BLOB_STORE_ID")
      resources.push({
        definition: storeName,
        host: "vercel",
        kind: "vercel-blob-store",
        owner: "blob",
        ...(store.secretEnv?.token
          ? { env: store.secretEnv.token, source: "env" }
          : !isMaskedBlobRuntimeValue(store.token)
          ? { source: "config" }
          : !store.tokenFromConfig && storeId
            ? { env: "BLOB_STORE_ID", id: storeId, source: "env" }
            : readEnv(env, "BLOB_READ_WRITE_TOKEN")
              ? { env: "BLOB_READ_WRITE_TOKEN", source: "env" }
              : { note: "Vercel sets `BLOB_STORE_ID` for the store that is connected to the project. Off Vercel, set `BLOB_READ_WRITE_TOKEN`." }),
      })
    }
  }
  return resources
}
