import * as v from "valibot"
import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"
// The package imports keep the Nitro module graph on the storage and runtime config that the generated Nitro plugin
// sets. Relative imports would load a second copy of the runtime state.
import { blob } from "@vite-hub/blob"
import { getBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"

import {
  blobDevDefaultListLimit,
  blobDevFileHeader,
  blobDevHeader,
  blobDevHeaderValue,
  blobDevTokenNamespace,
  blobDevTokenServerHeader,
  blobDevMaximumListLimit,
  blobDevMaximumUploadBytes,
  isBlobDevOperation,
} from "../dev.ts"

import type { BlobDevFileHeader, BlobDevRequestBody } from "../dev.ts"
import type { BlobObject, BlobResult, BlobStorage, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig } from "../types.ts"

/** Store names and drivers that the Blob configuration of this runtime defines. `default` is first. */
export interface BlobDevStore {
  driver: ResolvedBlobStoreConfig["driver"]
  name: string
}

/**
 * Blob metadata that the CLI prints. It matches the Console Blob page: the object URL is not included, because a
 * signed URL can carry credentials. Metadata values under secret names are redacted.
 */
export interface BlobDevObject {
  contentType?: string
  customMetadata: Record<string, unknown>
  httpEtag?: string
  httpMetadata: Record<string, unknown>
  pathname: string
  size?: number
  uploadedAt: string
  /** `true` when the storage returned a URL for the object. */
  urlAvailable?: true
}

export interface BlobDevListResult {
  blobs: BlobDevObject[]
  /** Present when more blobs exist. Pass it as `--cursor` to read the next page. */
  cursor?: string
  hasMore: boolean
  limit: number
  prefix: string
  store: string
  stores: string[]
}

export interface BlobDevHeadResult {
  object: BlobDevObject
  store: string
}

export interface BlobDevPutResult {
  /**
   * Whether the metadata read immediately before the write found no blob.
   * This is best-effort: eventually consistent providers and concurrent writers can make it stale.
   */
  created: boolean
  object: BlobDevObject
  store: string
}

export interface BlobDevDeleteResult {
  /**
   * Whether the metadata read immediately before the delete found a blob.
   * This is best-effort: eventually consistent providers and concurrent writers can make it stale.
   */
  deleted: boolean
  pathname: string
  store: string
}

class BlobDevRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

const maximumPathnameLength = 1_024
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  const error: { code?: string, message: string } = { message: redactInspectionText(message) }
  if (code) error.code = code
  return json({ error }, status)
}

function resolvedStores(config: false | ResolvedBlobModuleOptions): BlobDevStore[] {
  if (!config) return []
  const stores = Object.entries(config.stores ?? { default: config.store })
    .map(([name, store]) => ({ driver: store.driver, name }))
  return [
    ...stores.filter(store => store.name === "default"),
    ...stores.filter(store => store.name !== "default").sort((left, right) => left.name.localeCompare(right.name)),
  ]
}

/** Returns the Blob stores of this runtime. The dev handler accepts only these store names. */
export async function listBlobDevStores(): Promise<BlobDevStore[]> {
  return resolvedStores(await getBlobRuntimeConfig())
}

function redactedMetadata(value: Record<string, string>): Record<string, unknown> {
  const redacted = redactInspectionValue({ ...value })
  return v.is(v.record(v.string(), v.unknown()), redacted) ? { ...redacted } : {}
}

/** Converts one Blob object to the metadata that the CLI prints. */
export function serializeBlobDevObject(object: BlobObject): BlobDevObject {
  const serialized: BlobDevObject = {
    customMetadata: redactedMetadata(object.customMetadata),
    httpMetadata: redactedMetadata(object.httpMetadata),
    pathname: object.pathname,
    uploadedAt: object.uploadedAt.toISOString(),
  }
  if (object.contentType) serialized.contentType = object.contentType
  if (object.httpEtag) serialized.httpEtag = object.httpEtag
  if (object.size !== undefined) serialized.size = object.size
  if (object.url) serialized.urlAvailable = true
  return serialized
}

function notFound(pathname: string, store: string): BlobDevRequestError {
  return new BlobDevRequestError(`Blob ${pathname} was not found in store ${store}.`, 404, "BLOB_NOT_FOUND")
}

function unwrap<TResult>(result: BlobResult<TResult>): TResult {
  if (result[0] === null) return result[1]
  const error = result[0]
  const cause = error.cause
  const causeMessage = cause instanceof Error ? ` ${cause.message}` : ""
  throw new BlobDevRequestError(`${error.message}${causeMessage}`, 502, error.code)
}

/** Reads the metadata of one blob. Returns `undefined` when the blob does not exist. */
async function headOrUndefined(storage: BlobStorage, pathname: string): Promise<BlobObject | undefined> {
  const result = await storage.head(pathname)
  if (result[0]?.code === "BLOB_NOT_FOUND") return
  return unwrap(result)
}

function readString(body: Record<string, unknown>, name: string): string | undefined {
  const value: unknown = Reflect.get(body, name)
  if (value === undefined) return
  if (!v.is(v.string(), value)) throw new BlobDevRequestError(`${name} must be a string.`, 400)
  return value
}

function readPositiveInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value: unknown = Reflect.get(body, name)
  if (value === undefined) return
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), value)) {
    throw new BlobDevRequestError(`${name} must be a positive integer.`, 400)
  }
  return value
}

async function readBody(request: Request): Promise<BlobDevRequestBody> {
  const body: unknown = await request.json().catch(() => undefined)
  const record = v.safeParse(v.record(v.string(), v.unknown()), body)
  if (!record.success) throw new BlobDevRequestError("The Blob Dev request body is invalid.", 400)
  const operation: unknown = Reflect.get(record.output, "operation")
  if (!isBlobDevOperation(operation)) throw new BlobDevRequestError("The Blob Dev request body is invalid.", 400)
  const parsed: BlobDevRequestBody = { operation }
  const contentType = readString(record.output, "contentType")
  const cursor = readString(record.output, "cursor")
  const data = readString(record.output, "data")
  const limit = readPositiveInteger(record.output, "limit")
  const pathname = readString(record.output, "pathname")
  const prefix = readString(record.output, "prefix")
  const store = readString(record.output, "store")
  if (contentType) parsed.contentType = contentType
  if (cursor) parsed.cursor = cursor
  if (data !== undefined) parsed.data = data
  if (limit !== undefined) parsed.limit = limit
  if (pathname !== undefined) parsed.pathname = pathname
  if (prefix !== undefined) parsed.prefix = prefix
  if (store !== undefined) {
    if (!store.trim()) throw new BlobDevRequestError("store must be a non-empty string.", 400)
    parsed.store = store
  }
  return parsed
}

function selectStore(stores: readonly BlobDevStore[], name = "default"): { name: string, storage: BlobStorage } {
  if (stores.length === 0) {
    throw new BlobDevRequestError("Blob is disabled in this runtime. Configure `hubBlob()` without `blob: false`.", 409, "BLOB_DISABLED")
  }
  if (!stores.some(entry => entry.name === name)) {
    throw new BlobDevRequestError(`Blob store "${name}" was not found. Stores: ${stores.map(entry => entry.name).join(", ")}.`, 404, "BLOB_STORE_NOT_FOUND")
  }
  return { name, storage: name === "default" ? blob : blob.store(name) }
}

function requirePathname(body: BlobDevRequestBody): string {
  if (!body.pathname) throw new BlobDevRequestError(`The ${body.operation} operation requires a pathname.`, 400)
  if (body.pathname.length > maximumPathnameLength) throw new BlobDevRequestError("The pathname is too long.", 400)
  return body.pathname
}

function decodeUpload(data: string | undefined): Uint8Array {
  if (data === undefined) throw new BlobDevRequestError("The put operation requires file data.", 400)
  if (data.length % 4 !== 0 || !base64Pattern.test(data)) throw new BlobDevRequestError("The file data is not valid base64.", 400)
  // Check the size before decoding, so an oversized request does not allocate the decoded file.
  const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  if (size > blobDevMaximumUploadBytes) {
    throw new BlobDevRequestError(`The file is ${size} bytes. The Blob dev endpoint accepts at most ${blobDevMaximumUploadBytes} bytes.`, 413, "BLOB_DEV_UPLOAD_TOO_LARGE")
  }
  return Uint8Array.from(atob(data), character => character.charCodeAt(0))
}

async function runOperation(body: BlobDevRequestBody, stores: readonly BlobDevStore[]): Promise<Response> {
  const selected = selectStore(stores, body.store)
  switch (body.operation) {
    case "list": {
      const limit = body.limit ?? blobDevDefaultListLimit
      if (limit > blobDevMaximumListLimit) throw new BlobDevRequestError(`limit must be at most ${blobDevMaximumListLimit}.`, 400)
      if ((body.prefix?.length ?? 0) > maximumPathnameLength) throw new BlobDevRequestError("The prefix is too long.", 400)
      const listOptions: { cursor?: string, limit: number, prefix: string } = { limit, prefix: body.prefix ?? "" }
      if (body.cursor) listOptions.cursor = body.cursor
      const page = unwrap(await selected.storage.list(listOptions))
      const result: BlobDevListResult = {
        blobs: page.blobs.map(serializeBlobDevObject),
        hasMore: page.hasMore,
        limit,
        prefix: body.prefix ?? "",
        store: selected.name,
        stores: stores.map(store => store.name),
      }
      if (page.cursor) result.cursor = page.cursor
      return json(result)
    }
    case "head": {
      const pathname = requirePathname(body)
      const object = await headOrUndefined(selected.storage, pathname)
      if (!object) throw notFound(pathname, selected.name)
      const result: BlobDevHeadResult = { object: serializeBlobDevObject(object), store: selected.name }
      return json(result)
    }
    case "get": {
      const pathname = requirePathname(body)
      const file = unwrap(await selected.storage.get(pathname))
      if (!file) throw notFound(pathname, selected.name)
      const header: BlobDevFileHeader = {
        pathname,
        size: file.size,
        store: selected.name,
      }
      if (file.type) header.contentType = file.type
      // The body is the raw file. JSON is only used for the metadata header, so binary data stays unchanged.
      return new Response(file.stream(), {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          [blobDevFileHeader]: encodeURIComponent(JSON.stringify(header)),
        },
      })
    }
    case "put": {
      const pathname = requirePathname(body)
      const bytes = decodeUpload(body.data)
      const existed = await headOrUndefined(selected.storage, pathname)
      const object = unwrap(await selected.storage.put(pathname, bytes, body.contentType ? { contentType: body.contentType } : {}))
      const result: BlobDevPutResult = { created: !existed, object: serializeBlobDevObject(object), store: selected.name }
      return json(result)
    }
    case "del": {
      const pathname = requirePathname(body)
      const existed = await headOrUndefined(selected.storage, pathname)
      unwrap(await selected.storage.del(pathname))
      const result: BlobDevDeleteResult = { deleted: Boolean(existed), pathname, store: selected.name }
      return json(result)
    }
  }
}

/**
 * Handles one Blob operation from `vitehub blob`. The Vite Development Server forwards the request into the Nitro
 * runtime, so the operation uses the same Blob stores and bindings as the application.
 *
 * The request must carry the Blob dev header, must not come from another origin, and must use JSON. A successful
 * `get` returns the raw file bytes. Every other response is JSON.
 */
export async function handleBlobDevRequest(request: Request, storesOrRoot?: readonly BlobDevStore[] | string, rootDir: string = process.cwd(), serverId?: string): Promise<Response> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This overload boundary distinguishes the legacy root-path argument from configured stores.
  const stores = typeof storesOrRoot === "string" ? undefined : storesOrRoot
  if (typeof storesOrRoot === "string") {
    serverId = rootDir
    rootDir = storesOrRoot
  }
  const rejection = validateViteHubNitroDevRequest(request, { header: blobDevHeader, headerValue: blobDevHeaderValue, label: "Blob Dev" })
  if (rejection) return rejection
  if (serverId) {
    const requestedServerId = request.headers.get(blobDevTokenServerHeader)
    const token = request.headers.get(viteHubDevTokenHeader)
    if (requestedServerId !== serverId || !token || token !== await readViteHubDevToken(rootDir, { namespace: blobDevTokenNamespace, serverId })) {
      return new Response("Forbidden Blob Dev token.", { status: 403 })
    }
  }
  try {
    return await runOperation(await readBody(request), stores ?? await listBlobDevStores())
  }
  catch (error) {
    if (error instanceof BlobDevRequestError) return failure(error.message, error.status, error.code)
    return failure(`The Blob operation failed: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}
