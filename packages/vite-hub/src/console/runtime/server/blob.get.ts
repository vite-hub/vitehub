import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleBlob } from "./blob.ts"

import type { BlobObject, BlobResult, BlobStorage } from "@vite-hub/blob"
import type { ConsoleRequestEvent } from "./request.ts"

const defaultLimit = 100
const maximumLimit = 250
const maximumParameterLength = 8_192

interface ConsoleBlobObject {
  contentType?: string
  customMetadata: Record<string, string>
  httpEtag?: string
  httpMetadata: Record<string, string>
  pathname: string
  size?: number
  uploadedAt: string
  urlAvailable?: true
}

interface ConsoleBlobPage {
  blobs: ConsoleBlobObject[]
  cursor?: string
  hasMore: boolean
  limit: number
  prefix: string
  store: string
  stores: readonly string[]
}

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function optionalParameter(value: string | null, name: string): string | undefined {
  if (value === null || value === "") return
  if (value.length > maximumParameterLength) throw requestError(400, `${name} is too long.`)
  return value
}

function limitParameter(value: string | null): number {
  if (value === null || value === "") return defaultLimit
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximumLimit) {
    throw requestError(400, `limit must be an integer from 1 to ${maximumLimit}.`)
  }
  return parsed
}

function unwrap<TResult>(result: BlobResult<TResult>): TResult {
  if (result[0]) throw requestError(502, result[0].message)
  return result[1]
}

function selectStore(storage: BlobStorage, stores: readonly string[], requested: string | null): { name: string; storage: BlobStorage } {
  const name = requested === null || requested === "" ? "default" : requested
  if (!stores.includes(name)) throw requestError(404, "Blob store not found.")
  return { name, storage: name === "default" ? storage : storage.store(name) }
}

function serializeBlob(object: BlobObject): ConsoleBlobObject {
  const serialized: ConsoleBlobObject = {
    customMetadata: { ...object.customMetadata },
    httpMetadata: { ...object.httpMetadata },
    pathname: object.pathname,
    uploadedAt: object.uploadedAt.toISOString(),
  }
  if (object.contentType) serialized.contentType = object.contentType
  if (object.httpEtag) serialized.httpEtag = object.httpEtag
  if (object.size !== undefined) serialized.size = object.size
  if (object.url) serialized.urlAvailable = true
  return serialized
}

export default async function consoleBlobHandler(event: ConsoleRequestEvent): Promise<ConsoleBlobPage> {
  assertConsoleRequest(event)
  const url = consoleRequestURL(event)
  const inspection = getConsoleBlob()
  const selected = selectStore(inspection.storage, inspection.stores, url.searchParams.get("store"))
  const prefix = optionalParameter(url.searchParams.get("prefix"), "prefix") ?? ""
  const cursor = optionalParameter(url.searchParams.get("cursor"), "cursor")
  const limit = limitParameter(url.searchParams.get("limit"))
  const page = unwrap(await selected.storage.list({ cursor, limit, prefix }))
  const result: ConsoleBlobPage = {
    blobs: page.blobs.map(serializeBlob),
    hasMore: page.hasMore,
    limit,
    prefix,
    store: selected.name,
    stores: inspection.stores,
  }
  if (page.cursor) result.cursor = page.cursor
  return result
}
