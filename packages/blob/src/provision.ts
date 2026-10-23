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
import type { BlobModuleOptions, CloudflareR2Jurisdiction, ResolvedBlobStoreConfig } from "./types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

interface CloudflareR2Bucket {
  name?: string
}

interface CloudflareR2BucketTarget {
  jurisdiction?: CloudflareR2Jurisdiction
  name: string
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

// The R2 API reads and writes the default jurisdiction unless this header names another one.
function jurisdictionHeaders(jurisdiction: CloudflareR2Jurisdiction | undefined): Record<string, string> | undefined {
  return jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : undefined
}

async function listCloudflareR2BucketNames(request: CloudflareProvisionRequest, jurisdiction: CloudflareR2Jurisdiction | undefined): Promise<Set<string>> {
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const query: Record<string, string> = {
      per_page: CLOUDFLARE_R2_BUCKET_LIST_PER_PAGE,
    }
    if (cursor) query.cursor = cursor
    const listed = await request<{ buckets?: CloudflareR2Bucket[] }>("/r2/buckets", {
      headers: jurisdictionHeaders(jurisdiction),
      parse: parseCloudflareBuckets,
      query,
    })
    if (listed.result === undefined) {
      throw blobErrorDiagnostics.BLOB_R0018({ message: "Cloudflare R2 provisioning returned an invalid bucket list." })
    }
    for (const bucket of listed.result.buckets ?? []) {
      if (bucket.name) names.add(bucket.name)
    }

    const nextCursor = listed.result_info?.cursor?.trim()
    if (!nextCursor) return names
    if (cursors.has(nextCursor)) {
      throw blobErrorDiagnostics.BLOB_R0017({ message: "Cloudflare R2 bucket listing returned a repeated pagination cursor." })
    }
    cursors.add(nextCursor)
    cursor = nextCursor
  }
}

async function createCloudflareR2Bucket(request: CloudflareProvisionRequest, { jurisdiction, name: bucketName }: CloudflareR2BucketTarget): Promise<void> {
  const headers = jurisdictionHeaders(jurisdiction)
  try {
    await request("/r2/buckets", { method: "POST", body: { name: bucketName }, headers })
  }
  catch (error) {
    const duplicate = error instanceof ProvisionRequestError
      && (error.status === 409 || (error.status === 400 && error.codes.includes(10004)))
    if (!duplicate) throw error
    const existing = await request<CloudflareR2Bucket>(`/r2/buckets/${encodeURIComponent(bucketName)}`, {
      headers,
      parse: parseCloudflareBucket,
    })
    if (existing.result?.name !== bucketName) throw error
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || Object(value) !== value || Array.isArray(value)) throw blobErrorDiagnostics.BLOB_R0018({ message: "Provisioning returned an invalid response." })
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
  const object = parseObject(value)
  const buckets = object.buckets
  if (!Array.isArray(buckets)
    || Array.from(buckets).some((bucket, index) => !(index in buckets)
      || bucket === null
      || typeof bucket !== "object"
      || Array.isArray(bucket))) {
    throw blobErrorDiagnostics.BLOB_R0018({ message: "Cloudflare R2 provisioning returned an invalid bucket list." })
  }
  // SAFETY: The array and element boundary above establish the provider response shape.
  return object as { buckets: CloudflareR2Bucket[] }
}

function parseCloudflareBucket(value: unknown): CloudflareR2Bucket {
  return parseObject(value)
}

function vercelConnectionState(store: VercelBlobStore, projectId: string): "absent" | "equivalent" | "mismatched" {
  const connections = store.projectsMetadata?.filter(project => project.projectId === projectId)
  if (!connections?.length) return "absent"
  return connections.some(connection => VERCEL_PROJECT_ENVIRONMENTS.every(environment => connection.environments?.includes(environment)))
    ? "equivalent"
    : "mismatched"
}

async function readVercelBlobStore(
  request: ReturnType<typeof createVercelProvisionClient>,
  storeId: string,
): Promise<VercelBlobStore> {
  const response = await request(`/storage/stores/${storeId}`, { parse: parseVercelBlobStoreResponse })
  if (!response.store) {
    throw blobErrorDiagnostics.BLOB_R0019({ message: "Vercel Blob provisioning did not return store metadata." })
  }
  return response.store
}

// A team can hold the Blob stores of other projects. Reuse the store that is connected to this
// project, then a store that no project uses. Never connect a store that another project uses.
async function findVercelBlobStore(
  request: ReturnType<typeof createVercelProvisionClient>,
  stores: VercelBlobStore[],
  projectId: string,
): Promise<{ state: "absent" | "equivalent" | "mismatched", store: VercelBlobStore } | undefined> {
  let unused: VercelBlobStore | undefined
  let mismatched: VercelBlobStore | undefined
  for (const listed of stores) {
    if (!listed.id) continue
    const store = { ...listed, projectsMetadata: (await readVercelBlobStore(request, listed.id)).projectsMetadata }
    const state = vercelConnectionState(store, projectId)
    if (state === "equivalent") return { state, store }
    if (state === "mismatched") {
      mismatched ??= store
      continue
    }
    if (!store.projectsMetadata?.length) unused ??= store
  }
  if (mismatched) return { state: "mismatched", store: mismatched }
  return unused ? { state: "absent", store: unused } : undefined
}

async function ensureVercelBlobConnection(
  request: ReturnType<typeof createVercelProvisionClient>,
  storeId: string,
  projectId: string,
): Promise<void> {
  const state = vercelConnectionState(await readVercelBlobStore(request, storeId), projectId)
  if (state === "equivalent") return
  if (state === "mismatched") {
    throw blobErrorDiagnostics.BLOB_R0020({ message: "Vercel Blob is connected to the project without all required environments." })
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
      throw blobErrorDiagnostics.BLOB_R0021({ message: "Vercel Blob is connected to the project without all required environments." })
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
      // A bucket name is unique only inside its jurisdiction.
      const buckets = new Map<string, CloudflareR2BucketTarget>()
      for (const store of resolvedStores(resolveOptions(), context.env)) {
        if (store.driver !== "cloudflare-r2" || !store.bucketName) continue
        buckets.set(`${store.jurisdiction ?? "default"}/${store.bucketName}`, { jurisdiction: store.jurisdiction, name: store.bucketName })
      }
      if (!buckets.size) return []

      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("blob: skipping Cloudflare R2, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        context.markPlanUnchecked?.()
        return []
      }

      const request = createCloudflareProvisionClient(config, context.fetch)
      const existing = new Map<CloudflareR2Jurisdiction | undefined, Set<string>>()
      for (const { jurisdiction } of buckets.values()) {
        if (!existing.has(jurisdiction)) existing.set(jurisdiction, await listCloudflareR2BucketNames(request, jurisdiction))
      }

      return [...buckets.values()].map((bucket): ProvisionAction => {
        const exists = existing.get(bucket.jurisdiction)?.has(bucket.name) ?? false
        return {
          kind: "cloudflare-r2-bucket",
          name: bucket.jurisdiction ? `${bucket.name} (${bucket.jurisdiction})` : bucket.name,
          exists,
          apply: async () => {
            if (!exists) await createCloudflareR2Bucket(request, bucket)
            return {}
          },
        }
      })
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
        context.markPlanUnchecked?.()
        return []
      }

      const request = createVercelProvisionClient(config, context.fetch)
      const listed = await request("/v1/storage/stores", { parse: parseVercelBlobStoresResponse })
      const candidates = (listed.stores ?? []).filter(store =>
        (!store.type || store.type === "blob")
        && (store.access ?? "public") === requested.access,
      )
      const found = await findVercelBlobStore(request, candidates, projectId)
      const existing = found?.store
      const connectionState = found?.state ?? "absent"
      if (connectionState === "mismatched") {
        throw blobErrorDiagnostics.BLOB_R0020({ message: "Vercel Blob is connected to the project without all required environments." })
      }

      return [{
        kind: "vercel-blob-store",
        name: existing?.name ?? VERCEL_BLOB_STORE_NAME,
        exists: Boolean(existing),
        pending: !existing || connectionState !== "equivalent",
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
            throw blobErrorDiagnostics.BLOB_R0022({ message: "Vercel Blob provisioning did not return a store id." })
          }
          await ensureVercelBlobConnection(request, store.id, projectId)
          return {}
        },
      }]
    },
  }
}
