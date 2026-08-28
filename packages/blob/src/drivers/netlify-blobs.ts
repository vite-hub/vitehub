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
  [key: string]: unknown
}

type FoldedCursor = {
  directoriesConsumed: boolean
  index: number
  page?: number
  providerCursor?: string
}

type NetlifyListPage = {
  blobs?: NetlifyListBlob[]
  directories?: string[]
  next_cursor?: string
}

type NetlifyListBlob = {
  etag: string
  key: string
  last_modified?: string
  lastModified?: string
  size?: number
  uploaded_at?: string
  uploadedAt?: string
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
const MAX_FETCH_RETRIES = 5
const MIN_RETRY_DELAY = 1_000
const RATE_LIMIT_HEADER = "X-RateLimit-Reset"
function isNumber(value: unknown): value is number {
  return Number(value) === value
}

function isString(value: unknown): value is string {
  return String(value) === value
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(isString)
}

function isValidDateString(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value))
}

function metadataEnvelope(metadata: StoredMetadata): "files-sdk" | "legacy" | undefined {
  if (
    isString(metadata.__contentType)
    && isNumber(metadata.__lastModified)
    && Number.isFinite(metadata.__lastModified)
    && isNumber(metadata.__size)
    && Number.isFinite(metadata.__size)
    && metadata.__size >= 0
  ) return "files-sdk"
  if (
    isString(metadata.contentType)
    && isNumber(metadata.size)
    && Number.isFinite(metadata.size)
    && metadata.size >= 0
    && isValidDateString(metadata.uploadedAt)
  ) return "legacy"
  return undefined
}

function rawCustomMetadata(metadata: StoredMetadata, envelope = metadataEnvelope(metadata)): Record<string, string> {
  const reservedFields = envelope === "files-sdk"
    ? new Set(["__contentType", "__lastModified", "__size", "__user"])
    : envelope === "legacy"
      ? new Set(["contentType", "customMetadata", "size", "uploadedAt"])
      : new Set<string>()
  return Object.fromEntries(Object.entries(metadata).flatMap(([key, value]): [string, string][] =>
    !reservedFields.has(key) && isString(value) ? [[key, value]] : [],
  ))
}

function decodeBase64(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

function encodeBase64(value: string) {
  const binary = Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join("")
  return btoa(binary)
}

function encodeBase64Url(value: string) {
  return encodeBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function readProperty(value: unknown, key: string) {
  return value === Object(value) && !Array.isArray(value)
    ? Reflect.get(Object(value), key)
    : undefined
}

function decodeCursor(cursor: string | undefined): FoldedCursor {
  if (!cursor) return { directoriesConsumed: false, index: 0, page: 0 }
  try {
    const parsed: unknown = JSON.parse(decodeBase64(cursor))
    const index = readProperty(parsed, "index")
    const page = readProperty(parsed, "page")
    const providerCursor = readProperty(parsed, "providerCursor")
    return {
      directoriesConsumed: readProperty(parsed, "directoriesConsumed") === true,
      index: isNumber(index) && index >= 0 ? index : 0,
      page: isNumber(page) && page >= 0 ? page : undefined,
      providerCursor: isString(providerCursor) ? providerCursor : undefined,
    }
  }
  catch {
    return { directoriesConsumed: false, index: Number.parseInt(cursor) || 0, page: 0 }
  }
}

function getEnvironmentContext(): NetlifyEnvironmentContext {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (name: string) => string | undefined } }
    Netlify?: { env?: { get?: (name: string) => string | undefined } }
    process?: { env?: Record<string, string | undefined> }
  }
  const encoded = globalThis.netlifyBlobsContext
    || runtime.Netlify?.env?.get?.("NETLIFY_BLOBS_CONTEXT")
    || runtime.Deno?.env?.get?.("NETLIFY_BLOBS_CONTEXT")
    || runtime.process?.env?.NETLIFY_BLOBS_CONTEXT
  if (!isString(encoded) || !encoded) return {}
  try {
    const parsed: unknown = JSON.parse(decodeBase64(encoded))
    const context: NetlifyEnvironmentContext = {}
    for (const key of ["apiURL", "deployID", "edgeURL", "primaryRegion", "siteID", "token", "uncachedEdgeURL"] as const) {
      const value = readProperty(parsed, key)
      if (isString(value)) context[key] = value
    }
    return context
  }
  catch {
    return {}
  }
}

function getRetryDelay(response?: Response) {
  const reset = response?.headers.get(RATE_LIMIT_HEADER)
  if (!reset) return typeof process === "object" && process?.env?.NODE_ENV === "test" ? 1 : 5_000
  return Math.max(Number(reset) * 1_000 - Date.now(), MIN_RETRY_DELAY)
}

async function fetchWithRetry(url: URL, options: RequestInit, attemptsLeft = MAX_FETCH_RETRIES): Promise<Response> {
  while (true) {
    let response: Response
    try {
      response = await fetch(url, options)
    }
    catch (error) {
      if (attemptsLeft === 0) throw error
      attemptsLeft--
      await new Promise(resolve => setTimeout(resolve, getRetryDelay()))
      continue
    }
    if (attemptsLeft === 0 || (response.status !== 429 && response.status < 500)) return response
    attemptsLeft--
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, getRetryDelay(response)))
  }
}

interface ResolvedNetlifyConnection {
  context: NetlifyEnvironmentContext
  siteID: string
  token: string
}

function resolveNetlifyConnection(options: NetlifyBlobsStoreConfig): ResolvedNetlifyConnection {
  const hasExplicitCredentials = Boolean(options.siteID && options.token)
  const context = options.deployScoped || !hasExplicitCredentials ? getEnvironmentContext() : {}
  const siteID = options.siteID ?? context.siteID
  const token = options.token ?? context.token
  if (!siteID || !token) {
    throw new Error("The environment has not been configured to use Netlify Blobs. Supply siteID and token when creating the store.")
  }
  return { context, siteID, token }
}

function createListPageFetcher(options: NetlifyBlobsStoreConfig, connection: ResolvedNetlifyConnection) {
  const { context, siteID, token } = connection
  const storeName = options.deployScoped
    ? `deploy:${context.deployID}${options.name ? `:${options.name}` : ""}`
    : `site:${options.name}`
  const edgeURL = context.edgeURL
    ? options.consistency === "strong" ? context.uncachedEdgeURL : context.edgeURL
    : undefined
  if (options.consistency === "strong" && context.edgeURL && !edgeURL) {
    throw new Error("Netlify Blobs strong consistency requires an uncached edge URL.")
  }

  return async (parameters: Record<string, string>) => {
    const region = options.deployScoped && edgeURL ? context.primaryRegion : undefined
    if (options.deployScoped && !context.deployID) {
      throw new Error("The environment has not been configured with a Netlify deploy ID.")
    }
    if (options.deployScoped && edgeURL && !region) {
      throw new Error("Netlify Blobs deploy stores require a primary region when using the edge endpoint.")
    }
    const storePath = `${region ? `region:${region}/` : ""}${siteID}/${storeName}`
    const url = edgeURL
      ? new URL(edgeURL)
      : new URL(`/api/v1/blobs/${storePath}`, context.apiURL ?? "https://api.netlify.com")
    if (edgeURL) url.pathname = `${url.pathname.replace(/\/+$/, "")}/${storePath}`
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
    if (options.deployScoped && !edgeURL) url.searchParams.set("region", "auto")
    return await fetchWithRetry(url, { headers: { authorization: `Bearer ${token}` } })
  }
}

async function listPage(fetchPage: (parameters: Record<string, string>) => Promise<Response>, options: { cursor?: string, directories?: boolean, prefix?: string }) {
  const parameters: Record<string, string> = {}
  if (options.cursor) parameters.cursor = options.cursor
  if (options.directories) parameters.directories = "true"
  if (options.prefix) parameters.prefix = options.prefix
  const response = await fetchPage(parameters)
  if (response.status === 204 || response.status === 404) {
    await response.body?.cancel()
    return { blobs: [], directories: [] } satisfies NetlifyListPage
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`Netlify Blobs list failed with status ${response.status}.`)
  }
  const body: unknown = await response.json()
  const blobs = readProperty(body, "blobs")
  const directories = readProperty(body, "directories")
  const nextCursor = readProperty(body, "next_cursor")
  return {
    blobs: Array.isArray(blobs)
      ? blobs.flatMap((value): NetlifyListBlob[] => {
          const etag = readProperty(value, "etag")
          const key = readProperty(value, "key")
          if (!isString(etag) || !isString(key)) return []
          const blob: NetlifyListBlob = { etag, key }
          const size = readProperty(value, "size")
          if (isNumber(size) && Number.isFinite(size) && size >= 0) blob.size = size
          for (const field of ["last_modified", "lastModified", "uploaded_at", "uploadedAt"] as const) {
            const timestamp = readProperty(value, field)
            if (isString(timestamp)) blob[field] = timestamp
          }
          return [blob]
        })
      : [],
    directories: Array.isArray(directories)
      ? directories.filter(isString)
      : [],
    next_cursor: isString(nextCursor) ? nextCursor : undefined,
  }
}

async function mapWithConcurrency<T, U>(values: readonly T[], visit: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []
  let failure: { error: unknown } | undefined
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, values.length) }, async () => {
    while (!failure && nextIndex < values.length) {
      const index = nextIndex++
      try {
        results[index] = await visit(values[index]!)
      }
      catch (error) {
        failure ??= { error }
      }
    }
  }))
  if (failure) throw failure.error
  return results
}

function encodeCursor(cursor: FoldedCursor) {
  return encodeBase64Url(JSON.stringify(cursor))
}

function createStore(options: NetlifyBlobsStoreConfig, connection: ResolvedNetlifyConnection) {
  const { context, siteID, token } = connection
  const clientOptions = {
    apiURL: context.apiURL,
    consistency: options.consistency,
    edgeURL: context.edgeURL,
    siteID,
    token,
    uncachedEdgeURL: context.uncachedEdgeURL,
  }
  if (!options.deployScoped) return getStore({ ...clientOptions, name: options.name })

  const previousContext = globalThis.netlifyBlobsContext
  globalThis.netlifyBlobsContext = encodeBase64(JSON.stringify({ ...context, siteID, token }))
  try {
    return getDeployStore({ ...clientOptions, name: options.name })
  }
  finally {
    globalThis.netlifyBlobsContext = previousContext
  }
}

function toBlobObject(
  pathname: string,
  etag: string | undefined,
  metadata: StoredMetadata = {},
  listed?: Pick<NetlifyListBlob, "last_modified" | "lastModified" | "size" | "uploaded_at" | "uploadedAt">,
): BlobObject {
  const envelope = metadataEnvelope(metadata)
  const contentType = envelope === "files-sdk"
    ? metadata.__contentType
    : envelope === "legacy" ? metadata.contentType : undefined
  const customMetadata = rawCustomMetadata(metadata, envelope)
  if (isStringRecord(metadata.customMetadata)) Object.assign(customMetadata, metadata.customMetadata)
  if (isStringRecord(metadata.__user)) Object.assign(customMetadata, metadata.__user)
  const metadataSize = envelope === "files-sdk"
    ? metadata.__size
    : envelope === "legacy" ? metadata.size : undefined
  const size = metadataSize ?? listed?.size ?? 0
  const listedUploadTime = listed?.uploaded_at ?? listed?.uploadedAt ?? listed?.last_modified ?? listed?.lastModified
  const uploadedAt = envelope === "files-sdk"
    ? new Date(metadata.__lastModified!)
    : listedUploadTime ? new Date(listedUploadTime)
      : envelope === "legacy" ? new Date(metadata.uploadedAt!) : new Date(0)
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
  const connection = resolveNetlifyConnection(options)
  const store = createStore(options, connection)
  const fetchListPage = createListPageFetcher(options, connection)
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
      const envelope = metadataEnvelope(metadata)
      const contentType = envelope === "files-sdk"
        ? metadata.__contentType
        : envelope === "legacy" ? metadata.contentType : undefined
      return new Blob([result.data], { type: contentType })
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
      const selected: NetlifyListBlob[] = []
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
      const blobs = await mapWithConcurrency(selected, async (listed) => {
        const { etag, key } = listed
        const metadata = await store.getMetadata(key, { consistency: options.consistency })
        return toBlobObject(key, etag, metadata?.metadata as StoredMetadata | undefined, listed)
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
      const contentType = putOptions.contentType
        || (normalizedBody instanceof Blob ? normalizedBody.type : undefined)
        || "application/octet-stream"
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
