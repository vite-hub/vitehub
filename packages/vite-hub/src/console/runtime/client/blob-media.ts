import { isVitehubOwnedPath } from "@vite-hub/internal/owned-paths"

import { ConsoleRequestError, requestConsole } from "./request"
import { consoleMediaType } from "./media-library"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { ConsoleMediaAccess, ConsoleMediaClient, ConsoleMediaFile, ConsoleMediaListing } from "./media-library"

// The Blob section browses a Blob Store with the media browser of Content. The Blob route lists raw objects; this
// client maps them to media files and keeps the raw metadata for the detail panel. It uploads and deletes through the
// `blob.put` and `blob.del` operations. Folders, moves, and edits of media details are not part of a Blob Store.

/** One Blob object as the Console Blob route returns it. */
export interface ConsoleBlobObject {
  contentType?: string
  customMetadata: Record<string, string>
  httpEtag?: string
  httpMetadata: Record<string, string>
  pathname: string
  size?: number
  uploadedAt: string
  urlAvailable?: true
}

export interface ConsoleBlobPage {
  blobs: ConsoleBlobObject[]
  cursor?: string
  folders?: string[]
  hasMore: boolean
  limit: number
  prefix: string
  store: string
  stores: string[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function text(value: unknown): string | undefined {
  return String(value) === value ? value : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value)
  if (!source || Object.values(source).some(entry => text(entry) === undefined)) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0095({ message: "The Console returned invalid Blob metadata." })
  }
  return Object.fromEntries(Object.entries(source).map(([key, entry]) => [key, String(entry)]))
}

function parseBlob(value: unknown): ConsoleBlobObject {
  const source = record(value)
  const pathname = text(source?.pathname)
  const uploadedAt = text(source?.uploadedAt)
  if (!source || pathname === undefined || uploadedAt === undefined) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0096({ message: "The Console returned an invalid Blob object." })
  }
  const object: ConsoleBlobObject = {
    customMetadata: stringRecord(source.customMetadata),
    httpMetadata: stringRecord(source.httpMetadata),
    pathname,
    uploadedAt,
  }
  const contentType = text(source.contentType)
  if (contentType) object.contentType = contentType
  const httpEtag = text(source.httpEtag)
  if (httpEtag) object.httpEtag = httpEtag
  if (Number.isFinite(source.size)) object.size = Number(source.size)
  if (source.urlAvailable === true) object.urlAvailable = true
  return object
}

/** Validates a page of the Console Blob route. */
export function parseConsoleBlobPage(value: unknown): ConsoleBlobPage {
  const source = record(value)
  if (!source || !Array.isArray(source.blobs) || !Array.isArray(source.stores)) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0097({ message: "The Console returned an invalid Blob page." })
  }
  const page: ConsoleBlobPage = {
    blobs: source.blobs.map(parseBlob),
    hasMore: source.hasMore === true,
    limit: Number.isInteger(source.limit) ? Number(source.limit) : 100,
    prefix: text(source.prefix) ?? "",
    store: text(source.store) ?? "default",
    stores: source.stores.flatMap(store => text(store) ?? []),
  }
  const cursor = text(source.cursor)
  if (cursor) page.cursor = cursor
  if (Array.isArray(source.folders)) page.folders = source.folders.flatMap(folder => text(folder) ?? [])
  return page
}

// Stores record a content type at upload, but some drivers, such as `fs`, do not keep it. The browser then picks an
// icon from the file extension. The detail panel still shows the recorded type.
const extensionTypes: Record<string, string> = {
  avif: "image/avif", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  mov: "video/quicktime", mp4: "video/mp4", webm: "video/webm",
  csv: "text/csv", html: "text/html", md: "text/markdown", pdf: "application/pdf", txt: "text/plain",
}

function displayType(object: ConsoleBlobObject): string {
  if (object.contentType) return object.contentType
  const extension = /\.([a-z0-9]{1,5})$/i.exec(object.pathname)?.[1]?.toLowerCase()
  return (extension && extensionTypes[extension]) || "application/octet-stream"
}

/** A Blob object as a media file. A size the store did not record is `NaN`, which `consoleBytes()` shows as Unknown. */
export function consoleBlobMediaFile(object: ConsoleBlobObject): ConsoleMediaFile {
  return {
    contentType: displayType(object),
    createdAt: object.uploadedAt,
    name: object.pathname.slice(object.pathname.lastIndexOf("/") + 1) || object.pathname,
    pathname: object.pathname,
    size: object.size ?? Number.NaN,
    updatedAt: object.uploadedAt,
  }
}

/** Upload needs write, and delete needs manage. A read-only grant (`"blob:read"`) has neither. */
const writableAccess: ConsoleMediaAccess = { manage: true, read: true, write: true }
const readOnlyAccess: ConsoleMediaAccess = { manage: false, read: true, write: false }

/** Largest file that `blob.put` takes. The base64 text of the file travels in one JSON call. */
const maximumUploadBytes = 8 * 1024 * 1024

function unsupportedError(): Promise<never> {
  return Promise.reject(new ConsoleRequestError(405, "A Blob Store has no folders to create or move. Delete the object and upload it again."))
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.byteLength; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export interface ConsoleBlobMediaOptions {
  /** The access may only read the Blob section, so the page offers no upload or delete. */
  readOnly?: boolean
  /** Called with every page, for the store list. */
  onPage?: (page: ConsoleBlobPage) => void
  /** List objects under `_vitehub/`, which ViteHub writes for itself. */
  showVitehub?: boolean
  store: string
}

/** A media client for one Blob Store. `object()` returns the raw metadata of a listed object. */
export interface ConsoleBlobMediaClient extends ConsoleMediaClient {
  object(pathname: string): ConsoleBlobObject | undefined
}

/**
 * Lists one Blob Store through the Console Blob route as a read-only media library. Folders come from a folded listing.
 * Search matches the start of pathnames in the open folder, since Blob providers list by prefix. Write actions reject.
 */
export function createConsoleBlobMediaClient(base: string, options: ConsoleBlobMediaOptions): ConsoleBlobMediaClient {
  const objects = new Map<string, ConsoleBlobObject>()
  const blobAccess = options.readOnly ? readOnlyAccess : writableAccess

  async function page(query: { cursor?: string, folded: boolean, limit?: number, prefix: string }, signal?: AbortSignal): Promise<ConsoleBlobPage> {
    const request: Parameters<typeof requestConsole>[1] = {
      query: {
        cursor: query.cursor,
        folded: query.folded || undefined,
        limit: query.limit,
        prefix: query.prefix || undefined,
        showVitehub: options.showVitehub || undefined,
        store: options.store,
      },
    }
    if (signal) request.signal = signal
    const result = parseConsoleBlobPage(await requestConsole(base, request))
    for (const object of result.blobs) objects.set(object.pathname, object)
    options.onPage?.(result)
    return result
  }

  return {
    async list(query = {}, signal) {
      const folder = query.folder ?? ""
      const search = query.search ?? ""
      const listing = await page({
        ...(query.cursor ? { cursor: query.cursor } : {}),
        folded: !search,
        prefix: `${folder ? `${folder}/` : ""}${search}`,
      }, signal)
      // Folder markers end in `/` and are not files.
      const items = listing.blobs.filter(object => !object.pathname.endsWith("/")).map(consoleBlobMediaFile)
      const result: ConsoleMediaListing = {
        access: blobAccess,
        folder,
        folders: listing.folders ?? [],
        hasMore: listing.hasMore,
        items: query.type ? items.filter(item => consoleMediaType(item.contentType) === query.type) : items,
        served: null,
        store: listing.store,
      }
      if (listing.cursor) result.cursor = listing.cursor
      return result
    },
    async get(pathname) {
      const known = objects.get(pathname)
      if (known) return consoleBlobMediaFile(known)
      const listing = await page({ folded: false, limit: 10, prefix: pathname })
      const object = listing.blobs.find(entry => entry.pathname === pathname)
      if (!object) throw new ConsoleRequestError(404, `No object ${pathname} in store ${options.store}.`)
      return consoleBlobMediaFile(object)
    },
    info: async () => ({ access: blobAccess, served: null, store: options.store }),
    object: pathname => objects.get(pathname),
    usage: async () => ({}),
    createFolder: unsupportedError,
    isProtected: isVitehubOwnedPath,
    move: unsupportedError,
    moveFolder: unsupportedError,
    async remove(pathnames) {
      const removed: string[] = []
      const failed: Array<{ message: string, pathname: string }> = []
      for (const pathname of pathnames) {
        if (isVitehubOwnedPath(pathname)) {
          failed.push({ message: "ViteHub keeps this file for itself, so it cannot be deleted here.", pathname })
          continue
        }
        try {
          await requestConsole(base, { body: { action: "del", pathname, store: options.store }, method: "POST" })
          objects.delete(pathname)
          removed.push(pathname)
        }
        catch (error) {
          failed.push({ message: error instanceof Error ? error.message : "The object could not be deleted.", pathname })
        }
      }
      return { failed, removed }
    },
    removeCropReplacement: unsupportedError,
    removeFolder: unsupportedError,
    update: unsupportedError,
    async upload(file, uploadOptions = {}) {
      if (file.size > maximumUploadBytes) throw new ConsoleRequestError(413, `${file.name} is larger than 8 MiB. Upload larger files from the application or with the tools of your provider.`)
      const pathname = `${uploadOptions.folder ? `${uploadOptions.folder}/` : ""}${file.name}`
      if (isVitehubOwnedPath(pathname)) throw new ConsoleRequestError(403, "ViteHub keeps the paths under _vitehub/ for itself. Upload to another folder.")
      const data = base64(new Uint8Array(await file.arrayBuffer()))
      const send = (overwrite: boolean) => {
        const request: Parameters<typeof requestConsole>[1] = {
          body: { action: "put", contentType: file.type || undefined, data, overwrite, pathname, store: options.store },
          method: "POST",
        }
        if (uploadOptions.signal) request.signal = uploadOptions.signal
        return requestConsole(base, request)
      }
      let response: unknown
      try {
        // The first try never replaces a blob. A taken pathname asks the person before the second try does.
        response = await send(false)
      }
      catch (error) {
        if (!(error instanceof ConsoleRequestError) || error.failureCode !== "BLOB_EXISTS") throw error
        if (!await uploadOptions.confirmReplace?.(pathname)) throw new ConsoleRequestError(409, `${pathname} already exists, so it was not replaced.`)
        response = await send(true)
      }
      const result = record(response)
      const object = parseBlob(record(result?.object))
      objects.set(object.pathname, object)
      uploadOptions.onProgress?.(1)
      return { duplicate: false, file: consoleBlobMediaFile(object) }
    },
  }
}
