import { getDeployStore, getStore } from "@vite-hub/netlify-blobs-runtime"
import { toArray } from "@vite-hub/internal/arrays"

import type { BlobDriverAdapter, BlobObject, BlobPutBody, BlobPutOptions, NetlifyBlobsStoreConfig } from "../types.ts"

type StoredMetadata = {
  __contentType?: string
  __lastModified?: number
  __size?: number
  __user?: Record<string, string>
  contentType?: string
  customMetadata?: Record<string, string>
  size?: number
  uploadedAt?: string
}

type FoldedCursor = {
  directoriesConsumed: boolean
  index: number
  page?: number
  providerCursor?: string
}

type NetlifyListPage = {
  blobs?: Array<{ etag: string, key: string }>
  directories?: string[]
  next_cursor?: string
}

type NetlifyEnvironmentContext = {
  apiURL?: string
  deployID?: string
  edgeURL?: string
  primaryRegion?: string
  siteID?: string
  token?: string
  uncachedEdgeURL?: string
}

const METADATA_CONCURRENCY = 16

function decodeCursor(cursor: string | undefined): FoldedCursor {
  if (!cursor) return { directoriesConsumed: false, index: 0, page: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<FoldedCursor>
    return {
      directoriesConsumed: parsed.directoriesConsumed === true,
      index: typeof parsed.index === "number" && parsed.index >= 0 ? parsed.index : 0,
      page: typeof parsed.page === "number" && parsed.page >= 0 ? parsed.page : undefined,
      providerCursor: typeof parsed.providerCursor === "string" ? parsed.providerCursor : undefined,
    }
  }
  catch {
    return { directoriesConsumed: false, index: Number.parseInt(cursor) || 0, page: 0 }
  }
}

function getEnvironmentContext(): NetlifyEnvironmentContext {
  const encoded = globalThis.netlifyBlobsContext
  if (typeof encoded !== "string" || !encoded) return {}
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as NetlifyEnvironmentContext
  }
  catch {
    return {}
  }
}

function createListPageFetcher(options: NetlifyBlobsStoreConfig) {
  const environmentContext = getEnvironmentContext()
  const context = !options.deployScoped && options.siteID && options.token ? {} : environmentContext
  const siteID = context.siteID ?? options.siteID
  const token = context.token ?? options.token
  if (!siteID || !token) {
    throw new Error("The environment has not been configured to use Netlify Blobs. Supply siteID and token when creating the store.")
  }
  const storeName = options.deployScoped
    ? `deploy:${environmentContext.deployID}${options.name ? `:${options.name}` : ""}`
    : `site:${options.name}`
  const edgeURL = options.consistency === "strong" ? context.uncachedEdgeURL : context.edgeURL
  if (options.consistency === "strong" && context.edgeURL && !edgeURL) {
    throw new Error("Netlify Blobs strong consistency requires an uncached edge URL.")
  }

  return async (parameters: Record<string, string>) => {
    const region = options.deployScoped && edgeURL ? context.primaryRegion : undefined
    if (options.deployScoped && !environmentContext.deployID) {
      throw new Error("The environment has not been configured with a Netlify deploy ID.")
    }
    if (options.deployScoped && edgeURL && !region) {
      throw new Error("Netlify Blobs deploy stores require a primary region when using the edge endpoint.")
    }
    const pathname = edgeURL
      ? `/${region ? `region:${region}/` : ""}${siteID}/${storeName}`
      : `/api/v1/blobs/${siteID}/${storeName}`
    const url = new URL(pathname, edgeURL ?? context.apiURL ?? "https://api.netlify.com")
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
    if (options.deployScoped && !edgeURL) url.searchParams.set("region", "auto")
    return await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  }
}

async function listPage(fetchPage: (parameters: Record<string, string>) => Promise<Response>, options: { cursor?: string, directories?: boolean, prefix?: string }) {
  const parameters: Record<string, string> = {}
  if (options.cursor) parameters.cursor = options.cursor
  if (options.directories) parameters.directories = "true"
  if (options.prefix) parameters.prefix = options.prefix
  const response = await fetchPage(parameters)
  if (response.status === 204 || response.status === 404) return { blobs: [], directories: [] } satisfies NetlifyListPage
  if (response.status !== 200) throw new Error(`Netlify Blobs list failed with status ${response.status}.`)
  return await response.json() as NetlifyListPage
}

async function mapWithConcurrency<T, U>(values: readonly T[], visit: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await visit(values[index]!)
    }
  }))
  return results
}

function encodeCursor(cursor: FoldedCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function createStore(options: NetlifyBlobsStoreConfig) {
  const clientOptions = {
    consistency: options.consistency,
    siteID: options.siteID,
    token: options.token,
  }
  return options.deployScoped
    ? getDeployStore({ ...clientOptions, name: options.name })
    : getStore({ ...clientOptions, name: options.name })
}

function toBlobObject(pathname: string, etag: string | undefined, metadata: StoredMetadata = {}): BlobObject {
  const contentType = metadata.__contentType || metadata.contentType
  const customMetadata = metadata.__user || metadata.customMetadata || {}
  const size = metadata.__size ?? metadata.size ?? 0
  const uploadedAt = metadata.__lastModified
    ? new Date(metadata.__lastModified)
    : metadata.uploadedAt ? new Date(metadata.uploadedAt) : new Date(0)
  return {
    contentType,
    customMetadata,
    httpEtag: etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname,
    size,
    uploadedAt,
  }
}

async function normalizeBody(body: BlobPutBody) {
  if (body instanceof ReadableStream) return await new Response(body as never).arrayBuffer()
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice().buffer
  return body
}

export function createDriver(options: NetlifyBlobsStoreConfig): BlobDriverAdapter<NetlifyBlobsStoreConfig> {
  const store = createStore(options)
  const fetchListPage = createListPageFetcher(options)
  return {
    name: options.driver,
    options,
    async delete(pathnames) {
      await Promise.all(toArray(pathnames).map(pathname => store.delete(pathname)))
    },
    async get(pathname) {
      const result = await store.getWithMetadata(pathname, { consistency: options.consistency, type: "blob" })
      if (!result) return null
      const metadata = result.metadata as StoredMetadata
      return new Blob([result.data], { type: metadata.__contentType || metadata.contentType })
    },
    async getArrayBuffer(pathname) {
      const result = await store.getWithMetadata(pathname, { consistency: options.consistency, type: "arrayBuffer" })
      return result?.data || null
    },
    async head(pathname) {
      const result = await store.getMetadata(pathname, { consistency: options.consistency })
      return result ? toBlobObject(pathname, result.etag, result.metadata as StoredMetadata) : null
    },
    async list(listOptions = {}) {
      const cursor = decodeCursor(listOptions.cursor)
      const limit = listOptions.limit ?? 1000
      const selected: Array<{ etag: string, key: string }> = []
      const folders = new Set<string>()
      let hasMore = false
      let nextCursor: FoldedCursor | undefined
      let providerCursor = cursor.providerCursor
      let legacyPagesToSkip = cursor.page ?? 0
      let startIndex = cursor.index
      let directoriesConsumed = cursor.directoriesConsumed
      while (true) {
        const pageCursor = providerCursor
        const page = await listPage(fetchListPage, {
          cursor: pageCursor,
          directories: listOptions.folded,
          prefix: listOptions.prefix,
        })
        const blobs = page.blobs ?? []
        if (legacyPagesToSkip > 0) {
          legacyPagesToSkip--
          if (!page.next_cursor) break
          providerCursor = page.next_cursor
          continue
        }
        const consumeDirectories = !directoriesConsumed && (blobs.length === 0 || selected.length < limit)
        if (consumeDirectories) {
          for (const directory of page.directories ?? []) folders.add(directory)
          directoriesConsumed = true
        }
        for (let blobIndex = startIndex; blobIndex < blobs.length; blobIndex++) {
          if (selected.length === limit) {
            hasMore = true
            nextCursor = { directoriesConsumed, index: blobIndex, providerCursor: pageCursor }
            break
          }
          selected.push(blobs[blobIndex]!)
        }
        if (hasMore) break
        if (!page.next_cursor) break
        providerCursor = page.next_cursor
        startIndex = 0
        directoriesConsumed = false
      }
      const blobs = await mapWithConcurrency(selected, async ({ etag, key }) => {
        const metadata = await store.getMetadata(key, { consistency: options.consistency })
        return toBlobObject(key, etag, metadata?.metadata as StoredMetadata | undefined)
      })
      return {
        blobs,
        cursor: hasMore && nextCursor ? encodeCursor(nextCursor) : undefined,
        folders: listOptions.folded ? [...folders] : undefined,
        hasMore,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const normalizedBody = await normalizeBody(body)
      const contentType = putOptions.contentType || (normalizedBody instanceof Blob ? normalizedBody.type : undefined)
      const size = typeof normalizedBody === "string"
        ? new TextEncoder().encode(normalizedBody).byteLength
        : normalizedBody instanceof Blob
          ? normalizedBody.size
          : normalizedBody.byteLength
      const uploadedAt = new Date()
      const metadata: StoredMetadata = {
        __contentType: contentType,
        __lastModified: uploadedAt.getTime(),
        __size: size,
        __user: putOptions.customMetadata,
      }
      const result = await store.set(pathname, normalizedBody, {
        metadata,
      })
      return {
        ...toBlobObject(pathname, result.etag, metadata),
      }
    },
  }
}
