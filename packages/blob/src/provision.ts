import {
  createCloudflareProvisionClient,
  createVercelProvisionClient,
  ProvisionRequestError,
  resolveCloudflareProvisionConfig,
  resolveVercelProvisionConfig,
} from "@vite-hub/internal/provision"
import { readEnv } from "@vite-hub/internal/env"

import { resolveBlobViteConfig } from "./vite-config.ts"

import type { CloudflareProvisionRequest, ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import type { BlobModuleOptions, ResolvedBlobStoreConfig } from "./types.ts"

interface CloudflareR2Bucket {
  name?: string
}

interface VercelBlobStore {
  access?: "private" | "public"
  id?: string
  name?: string
  projectsMetadata?: VercelBlobProjectMetadata[]
  type?: string
}

interface VercelBlobProjectMetadata {
  environments?: string[]
  projectId?: string
}

interface VercelBlobStoresResponse {
  stores?: VercelBlobStore[]
}

interface VercelBlobStoreCreateResponse {
  store?: VercelBlobStore
}

interface VercelBlobStoreResponse {
  store?: VercelBlobStore
}

const VERCEL_BLOB_STORE_NAME = "vitehub-blob"
const VERCEL_BLOB_STORE_REGION = "iad1"
const VERCEL_PROJECT_ENVIRONMENTS = ["production", "preview", "development"] as const
const CLOUDFLARE_R2_BUCKET_LIST_PER_PAGE = "1000"

async function listCloudflareR2BucketNames(request: CloudflareProvisionRequest): Promise<Set<string>> {
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const query: Record<string, string> = {
      per_page: CLOUDFLARE_R2_BUCKET_LIST_PER_PAGE,
    }
    if (cursor) query.cursor = cursor
    const listed = await request<{ buckets?: CloudflareR2Bucket[] }>("/r2/buckets", {
      parse: parseCloudflareBuckets,
      query,
    })
    for (const bucket of listed.result?.buckets ?? []) {
      if (bucket.name) names.add(bucket.name)
    }

    const nextCursor = listed.result_info?.cursor?.trim()
    if (!nextCursor) return names
    if (cursors.has(nextCursor)) {
      throw new Error("Cloudflare R2 bucket listing returned a repeated pagination cursor.")
    }
    cursors.add(nextCursor)
    cursor = nextCursor
  }
}

async function createCloudflareR2Bucket(request: CloudflareProvisionRequest, bucketName: string): Promise<void> {
  try {
    await request("/r2/buckets", { method: "POST", body: { name: bucketName } })
  }
  catch (error) {
    const duplicate = error instanceof ProvisionRequestError
      && (error.status === 409 || (error.status === 400 && error.codes.includes(10004)))
    if (!duplicate) throw error
    const existing = await request<CloudflareR2Bucket>(`/r2/buckets/${encodeURIComponent(bucketName)}`, {
      parse: parseCloudflareBucket,
    })
    if (existing.result?.name !== bucketName) throw error
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || Object(value) !== value) throw new Error("Provisioning returned an invalid response.")
  // SAFETY: The object check establishes the string-keyed JSON object representation.
  return value as Record<string, unknown>
}

function parseVercelBlobStoreResponse(value: unknown): VercelBlobStoreResponse {
  return parseObject(value)
}

function parseVercelBlobStoresResponse(value: unknown): VercelBlobStoresResponse {
  return parseObject(value)
}

function parseVercelBlobStoreCreateResponse(value: unknown): VercelBlobStoreCreateResponse {
  return parseObject(value)
}

function parseCloudflareBuckets(value: unknown): { buckets?: CloudflareR2Bucket[] } {
  return parseObject(value)
}

function parseCloudflareBucket(value: unknown): CloudflareR2Bucket {
  return parseObject(value)
}

function vercelConnectionState(store: VercelBlobStore, projectId: string): "absent" | "equivalent" | "mismatched" {
  const connection = store.projectsMetadata?.find(project => project.projectId === projectId)
  if (!connection) return "absent"
  return VERCEL_PROJECT_ENVIRONMENTS.every(environment => connection.environments?.includes(environment))
    ? "equivalent"
    : "mismatched"
}

async function readVercelBlobStore(
  request: ReturnType<typeof createVercelProvisionClient>,
  storeId: string,
): Promise<VercelBlobStore> {
  const response = await request(`/storage/stores/${storeId}`, { parse: parseVercelBlobStoreResponse })
  if (!response.store) {
    throw new Error("Vercel Blob provisioning did not return store metadata.")
  }
  return response.store
}

async function ensureVercelBlobConnection(
  request: ReturnType<typeof createVercelProvisionClient>,
  storeId: string,
  projectId: string,
): Promise<void> {
  const state = vercelConnectionState(await readVercelBlobStore(request, storeId), projectId)
  if (state === "equivalent") return
  if (state === "mismatched") {
    throw new Error("Vercel Blob is connected to the project without all required environments.")
  }

  try {
    await request(`/v1/storage/stores/${storeId}/connections`, {
      method: "POST",
      body: {
        envVarEnvironments: VERCEL_PROJECT_ENVIRONMENTS,
        projectId,
        type: "integration",
      },
    })
  }
  catch (error) {
    if (!(error instanceof ProvisionRequestError) || error.status !== 400) throw error
    const current = vercelConnectionState(await readVercelBlobStore(request, storeId), projectId)
    if (current === "equivalent") return
    if (current === "mismatched") {
      throw new Error("Vercel Blob is connected to the project without all required environments.")
    }
    throw error
  }
}

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
      const existing = await listCloudflareR2BucketNames(request)

      return [...new Set(buckets)].map((bucketName): ProvisionAction => ({
        kind: "cloudflare-r2-bucket",
        name: bucketName,
        exists: existing.has(bucketName),
        apply: async () => {
          if (!existing.has(bucketName)) {
            await createCloudflareR2Bucket(request, bucketName)
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
      const requested = resolvedStores(resolveOptions(), context.env).find(store => store.driver === "vercel-blob")
      if (!requested || requested.driver !== "vercel-blob") return []

      const config = resolveVercelProvisionConfig(context.env)
      const projectId = readEnv(context.env, "VERCEL_PROJECT_ID")
      if (!config || !projectId) {
        context.logger.warn("blob: skipping Vercel Blob, missing VERCEL_TOKEN/VERCEL_PROJECT_ID.")
        return []
      }

      const request = createVercelProvisionClient(config, context.fetch)
      const listed = await request("/v1/storage/stores", { parse: parseVercelBlobStoresResponse })
      const existing = (listed.stores ?? []).find(store =>
        (!store.type || store.type === "blob")
        && (store.access ?? "public") === requested.access,
      )

      return [{
        kind: "vercel-blob-store",
        name: existing?.name ?? VERCEL_BLOB_STORE_NAME,
        exists: Boolean(existing),
        apply: async () => {
          const store = existing ?? (await request("/v1/storage/stores/blob", {
            method: "POST",
            parse: parseVercelBlobStoreCreateResponse,
            body: {
              access: requested.access,
              name: VERCEL_BLOB_STORE_NAME,
              region: VERCEL_BLOB_STORE_REGION,
            },
          })).store
          if (!store?.id) {
            throw new Error("Vercel Blob provisioning did not return a store id.")
          }
          await ensureVercelBlobConnection(request, store.id, projectId)
          return {}
        },
      }]
    },
  }
}
