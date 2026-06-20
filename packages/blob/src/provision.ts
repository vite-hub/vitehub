import {
  createCloudflareProvisionClient,
  createVercelProvisionClient,
  resolveCloudflareProvisionConfig,
  resolveVercelProvisionConfig,
} from "@vite-hub/internal/provision"
import { readEnv } from "@vite-hub/internal/env"

import { resolveBlobViteConfig } from "./vite-config.ts"

import type { ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import type { BlobModuleOptions, ResolvedBlobStoreConfig } from "./types.ts"

interface CloudflareR2Bucket {
  name?: string
}

interface VercelBlobStore {
  id?: string
  name?: string
  type?: string
}

interface VercelBlobStoresResponse {
  stores?: VercelBlobStore[]
}

interface VercelBlobStoreCreateResponse {
  store?: { id?: string }
  // Token returned on creation; treated as a secret, never persisted to disk or logged.
  token?: string
  BLOB_READ_WRITE_TOKEN?: string
}

const VERCEL_BLOB_STORE_NAME = "vitehub-blob"

function resolvedStores(options: BlobModuleOptions | undefined, env: Record<string, string | undefined>): ResolvedBlobStoreConfig[] {
  const config = resolveBlobViteConfig(options, { env })
  if (config.blob === false) return []
  return Object.values(config.blob.stores ?? { default: config.blob.store })
}

export function createBlobCloudflareProvisionStep(resolveOptions: () => BlobModuleOptions | undefined): ProvisionStep {
  return {
    id: "blob:cloudflare-r2",
    provider: "cloudflare",
    async plan(context) {
      const buckets = resolvedStores(resolveOptions(), context.env)
        .flatMap(store => store.driver === "cloudflare-r2" && store.bucketName ? [store.bucketName] : [])
      if (!buckets.length) return []

      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("blob: skipping Cloudflare R2, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        return []
      }

      const request = createCloudflareProvisionClient(config, context.fetch)
      const listed = await request<{ buckets?: CloudflareR2Bucket[] }>("/r2/buckets")
      const existing = new Set((listed.result?.buckets ?? []).map(bucket => bucket.name).filter((name): name is string => Boolean(name)))

      return [...new Set(buckets)].map((bucketName): ProvisionAction => ({
        kind: "cloudflare-r2-bucket",
        name: bucketName,
        exists: existing.has(bucketName),
        apply: async () => {
          if (!existing.has(bucketName)) {
            await request(`/r2/buckets`, { method: "POST", body: { name: bucketName } })
          }
          return {}
        },
      }))
    },
  }
}

export function createBlobVercelProvisionStep(resolveOptions: () => BlobModuleOptions | undefined): ProvisionStep {
  return {
    id: "blob:vercel-blob",
    provider: "vercel",
    async plan(context) {
      const usesVercelBlob = resolvedStores(resolveOptions(), context.env).some(store => store.driver === "vercel-blob")
      if (!usesVercelBlob) return []

      const config = resolveVercelProvisionConfig(context.env)
      const projectId = readEnv(context.env, "VERCEL_PROJECT_ID")
      if (!config || !projectId) {
        context.logger.warn("blob: skipping Vercel Blob, missing VERCEL_TOKEN/VERCEL_PROJECT_ID.")
        return []
      }

      const request = createVercelProvisionClient(config, context.fetch)
      const listed = await request<VercelBlobStoresResponse>("/v1/storage/stores")
      const existing = (listed.stores ?? []).find(store => store.type === "blob")

      return [{
        kind: "vercel-blob-store",
        name: existing?.name ?? VERCEL_BLOB_STORE_NAME,
        exists: Boolean(existing),
        apply: async () => {
          const token = existing
            ? readEnv(context.env, "BLOB_READ_WRITE_TOKEN")
            : extractToken(await request<VercelBlobStoreCreateResponse>("/v1/storage/stores", {
                method: "POST",
                body: { type: "blob", name: VERCEL_BLOB_STORE_NAME },
              }))
          if (token) {
            await pushVercelProjectEnv(request, projectId, "BLOB_READ_WRITE_TOKEN", token)
          }
          return {}
        },
      }]
    },
  }
}

function extractToken(response: VercelBlobStoreCreateResponse): string | undefined {
  return response.token ?? response.BLOB_READ_WRITE_TOKEN
}

// Pushes a secret to the Vercel project env store. The value is never written to disk or logged.
async function pushVercelProjectEnv(
  request: ReturnType<typeof createVercelProvisionClient>,
  projectId: string,
  key: string,
  value: string,
): Promise<void> {
  await request(`/v10/projects/${projectId}/env`, {
    method: "POST",
    query: { upsert: "true" },
    body: { key, value, type: "encrypted", target: ["production", "preview", "development"] },
  })
}
