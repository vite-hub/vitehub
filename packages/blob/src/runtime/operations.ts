import * as v from "valibot"
import { isVitehubOwnedPath } from "@vite-hub/internal/owned-paths"
import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"
// The package imports keep the Nitro module graph on the storage and runtime config that the generated Nitro plugin
// sets. Relative imports would load a second copy of the runtime state.
import { blob } from "@vite-hub/blob"
import { getBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"

import {
  blobDevDefaultListLimit,
  blobDevMaximumListLimit,
  blobDevMaximumUploadBytes,
} from "../results.ts"

import type { BlobObject, BlobResult, BlobStorage, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig } from "../types.ts"
import type { MediaRecord, MediaVariantEntry } from "../media/types.ts"

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
  /** With `folded`: the folders directly under `prefix`, without a trailing slash. */
  folders?: string[]
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

/** One downloaded file. The bytes travel as base64 in the JSON result. */
export interface BlobDevGetResult {
  contentType?: string
  /** The file, as base64. */
  data: string
  pathname: string
  size: number
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

export interface BlobDevMediaResult {
  record: MediaRecord
  store: string
}

export interface BlobDevVariantsResult {
  pathname: string
  store: string
  variants: MediaVariantEntry[]
}

/** The input of a `blob.*` operation, after the schema checked it. */
export interface BlobOperationInput {
  contentType?: string
  cursor?: string
  /** `put`: the file as base64. */
  data?: string
  /** `list`: group the pathnames under `prefix` into folders. */
  folded?: boolean
  limit?: number
  pathname?: string
  prefix?: string
  /** `list`: also show the objects that ViteHub keeps for itself. */
  showVitehub?: boolean
  /** Store name. Defaults to `default`. */
  store?: string
}

/** A failure with the fields that every surface reports. */
export class BlobOperationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(redactInspectionText(message))
  }
}

const maximumPathnameLength = 1_024
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/
// Bounds provider calls when many ViteHub-owned objects precede visible ones.
const maximumListPages = 10

function resolvedStores(config: false | ResolvedBlobModuleOptions): BlobDevStore[] {
  if (!config) return []
  const stores = Object.entries(config.stores ?? { default: config.store })
    .map(([name, store]) => ({ driver: store.driver, name }))
  return [
    ...stores.filter(store => store.name === "default"),
    ...stores.filter(store => store.name !== "default").sort((left, right) => left.name.localeCompare(right.name)),
  ]
}

/** Returns the Blob stores of this runtime. The operations accept only these store names. */
export async function listBlobDevStores(): Promise<BlobDevStore[]> {
  return resolvedStores(await getBlobRuntimeConfig())
}

function redactedMetadata(value: Record<string, string>): Record<string, unknown> {
  const redacted = redactInspectionValue({ ...value })
  return v.is(v.record(v.string(), v.unknown()), redacted) ? { ...redacted } : {}
}

/** Converts one Blob object to the metadata that the CLI and the Console show. */
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

function notFound(pathname: string, store: string): BlobOperationError {
  return new BlobOperationError(`Blob ${pathname} was not found in store ${store}.`, 404, "BLOB_NOT_FOUND")
}

function unwrap<TResult>(result: BlobResult<TResult>): TResult {
  if (result[0] === null) return result[1]
  const error = result[0]
  const cause = error.cause
  const causeMessage = cause instanceof Error ? ` ${cause.message}` : ""
  throw new BlobOperationError(`${error.message}${causeMessage}`, 502, error.code)
}

/** Reads the metadata of one blob. Returns `undefined` when the blob does not exist. */
async function headOrUndefined(storage: BlobStorage, pathname: string): Promise<BlobObject | undefined> {
  return unwrap(await storage.head(pathname)) ?? undefined
}

function selectStore(stores: readonly BlobDevStore[], name = "default"): { name: string, storage: BlobStorage } {
  if (stores.length === 0) {
    throw new BlobOperationError("Blob is disabled in this runtime. Configure `hubBlob()` without `blob: false`.", 409, "BLOB_DISABLED", "Enable Blob with hubBlob() or vitehub({ blob: true }).")
  }
  if (!stores.some(entry => entry.name === name)) {
    throw new BlobOperationError(`Blob store "${name}" was not found. Stores: ${stores.map(entry => entry.name).join(", ")}.`, 404, "BLOB_STORE_NOT_FOUND")
  }
  return { name, storage: name === "default" ? blob : blob.store(name) }
}

function requirePathname(operation: string, input: BlobOperationInput): string {
  if (!input.pathname) throw new BlobOperationError(`The ${operation} operation requires a pathname.`, 400, "BLOB_INVALID_INPUT")
  if (input.pathname.length > maximumPathnameLength) throw new BlobOperationError("The pathname is too long.", 400, "BLOB_INVALID_INPUT")
  return input.pathname
}

function decodeUpload(data: string | undefined): Uint8Array {
  if (data === undefined) throw new BlobOperationError("The put operation requires file data.", 400, "BLOB_INVALID_INPUT")
  if (data.length % 4 !== 0 || !base64Pattern.test(data)) throw new BlobOperationError("The file data is not valid base64.", 400, "BLOB_INVALID_INPUT")
  // Check the size before decoding, so an oversized request does not allocate the decoded file.
  const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  if (size > blobDevMaximumUploadBytes) {
    throw new BlobOperationError(`The file is ${size} bytes. The blob operations accept at most ${blobDevMaximumUploadBytes} bytes.`, 413, "BLOB_UPLOAD_TOO_LARGE", "Upload larger files from the application or with the tools of the provider.")
  }
  return Uint8Array.from(atob(data), character => character.charCodeAt(0))
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * Runs one `blob.*` operation against the Blob stores of this runtime. The Nitro runtime owns the stores and their
 * bindings, so this runs where the app does.
 */
export async function runBlobOperation(operation: "list" | "head" | "get" | "put" | "del" | "media" | "variants", input: BlobOperationInput, stores?: readonly BlobDevStore[]): Promise<unknown> {
  const available = stores ?? await listBlobDevStores()
  const selected = selectStore(available, input.store)
  switch (operation) {
    case "list": {
      const limit = input.limit ?? blobDevDefaultListLimit
      if (limit > blobDevMaximumListLimit) throw new BlobOperationError(`limit must be at most ${blobDevMaximumListLimit}.`, 400, "BLOB_INVALID_INPUT")
      if ((input.prefix?.length ?? 0) > maximumPathnameLength) throw new BlobOperationError("The prefix is too long.", 400, "BLOB_INVALID_INPUT")
      const prefix = input.prefix ?? ""
      const folded = input.folded === true
      const visible = (pathname: string) => input.showVitehub === true || !isVitehubOwnedPath(pathname)
      const listOptions = (cursor: string | undefined, size: number) => ({ ...(cursor ? { cursor } : {}), ...(folded ? { folded } : {}), limit: size, prefix })
      let page = unwrap(await selected.storage.list(listOptions(input.cursor, limit)))
      const blobs = page.blobs.filter(object => visible(object.pathname))
      const folders = new Set((page.folders ?? []).filter(visible))
      // Hidden objects can leave a page short. Fill it without passing the requested limit.
      for (let pages = 1; input.showVitehub !== true && blobs.length < limit && page.hasMore && page.cursor && pages < maximumListPages; pages++) {
        page = unwrap(await selected.storage.list(listOptions(page.cursor, limit - blobs.length)))
        blobs.push(...page.blobs.filter(object => visible(object.pathname)))
        for (const folder of page.folders ?? []) if (visible(folder)) folders.add(folder)
      }
      const result: BlobDevListResult = {
        blobs: blobs.map(serializeBlobDevObject),
        hasMore: page.hasMore,
        limit,
        prefix,
        store: selected.name,
        stores: available.map(store => store.name),
      }
      if (folded) result.folders = [...folders].map(folder => folder.replace(/\/+$/, "")).sort((left, right) => left.localeCompare(right))
      if (page.cursor) result.cursor = page.cursor
      return result
    }
    case "head": {
      const pathname = requirePathname(operation, input)
      const object = await headOrUndefined(selected.storage, pathname)
      if (!object) throw notFound(pathname, selected.name)
      const result: BlobDevHeadResult = { object: serializeBlobDevObject(object), store: selected.name }
      return result
    }
    case "get": {
      const pathname = requirePathname(operation, input)
      const object = await headOrUndefined(selected.storage, pathname)
      if (!object) throw notFound(pathname, selected.name)
      if ((object.size ?? 0) > blobDevMaximumUploadBytes) {
        throw new BlobOperationError(`Blob ${pathname} is ${object.size} bytes. The blob operations return at most ${blobDevMaximumUploadBytes} bytes.`, 413, "BLOB_DOWNLOAD_TOO_LARGE", "Download larger files with the tools of the provider.")
      }
      const file = unwrap(await selected.storage.get(pathname))
      if (!file) throw notFound(pathname, selected.name)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result: BlobDevGetResult = { data: encodeBase64(bytes), pathname, size: bytes.byteLength, store: selected.name }
      if (file.type) result.contentType = file.type
      return result
    }
    case "put": {
      const pathname = requirePathname(operation, input)
      const bytes = decodeUpload(input.data)
      const existed = await headOrUndefined(selected.storage, pathname)
      const object = unwrap(await selected.storage.put(pathname, bytes, input.contentType ? { contentType: input.contentType } : {}))
      const result: BlobDevPutResult = { created: !existed, object: serializeBlobDevObject(object), store: selected.name }
      return result
    }
    case "media": {
      const pathname = requirePathname(operation, input)
      const record = unwrap(await selected.storage.media.get(pathname))
      if (!record) throw notFound(pathname, selected.name)
      const result: BlobDevMediaResult = { record, store: selected.name }
      return result
    }
    case "variants": {
      const pathname = requirePathname(operation, input)
      if (!await headOrUndefined(selected.storage, pathname)) throw notFound(pathname, selected.name)
      const result: BlobDevVariantsResult = { pathname, store: selected.name, variants: unwrap(await selected.storage.media.variants(pathname)) }
      return result
    }
    case "del": {
      const pathname = requirePathname(operation, input)
      const existed = await headOrUndefined(selected.storage, pathname)
      unwrap(await selected.storage.del(pathname))
      const result: BlobDevDeleteResult = { deleted: Boolean(existed), pathname, store: selected.name }
      return result
    }
  }
}
