import { getBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"

import { consoleAccessAllows, type ConsoleAccess } from "./access.ts"
import { getConsoleBlob } from "./blob.ts"
import { consoleActionError, consoleDocumentActionContext, loadConsoleDocumentActions, runConsoleDocumentAction, type ConsoleMediaAccess } from "./documents.ts"
import { consoleRequestError } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { BlobResult, BlobStorage, MediaFocalPoint, MediaRecord, MediaUpdate } from "@vite-hub/blob"

/**
 * The media library of a document editor section. Blob owns storage: every change runs through `blob.media` of the Blob
 * Store that `blob.serve` serves, so the files the library shows are the files a site can serve. The section owner
 * decides who may do what with its `mediaAccess` action, and finds the documents that use a file with `references`.
 */

/** The media actions that one Console request may call. */
export const consoleMediaActionNames = ["createFolder", "get", "info", "list", "move", "moveFolder", "remove", "removeCropReplacement", "removeFolder", "update", "usage"] as const

export type ConsoleMediaActionName = (typeof consoleMediaActionNames)[number]

/** Largest file the Console uploads in one request. Hosts may lower it, such as Vercel Functions at 4.5 MB. */
export const maximumConsoleMediaUploadBytes: number = 32 * 1024 * 1024

/** Largest JSON request of a media action. */
export const maximumConsoleMediaRequestBytes: number = 256 * 1024

const listLimit = 200
const searchScanLimit = 5_000
const searchResultLimit = 60
const maximumBulk = 100
/**
 * Folders that ViteHub writes in the store root. `_vitehub/` is Blob's reserved namespace, which `media.list()` already
 * hides. `vitehub/` holds Workspace history when a Blob + Database Workspace Store shares the served store.
 */
const hiddenRootFolders = new Set(["vitehub"])

export type ConsoleMediaType = "image" | "video" | "audio" | "document" | "other"

/** One file as the media library shows it. It mirrors `MediaRecord` without the provider ETag and hash. */
export interface ConsoleMediaFile extends Omit<MediaRecord, "etag" | "hash"> {
  /** File name without the folder. */
  name: string
}

/** What the library and the picker need before they list anything. */
export interface ConsoleMediaInfo {
  access: ConsoleMediaAccess
  /** The served URL that a pathname is appended to, such as `/api/_vitehub/blob/`, or null when the store is not served. */
  served: string | null
  store: string
}

/** One folder level of the media library. */
export interface ConsoleMediaListing {
  access: ConsoleMediaAccess
  /** The listed folder without slashes at either end, or `""` for the root. */
  folder: string
  /** Child folders, as paths without a trailing slash. Empty while searching. */
  folders: string[]
  items: ConsoleMediaFile[]
  /** More files follow. Pass `cursor` to read them. */
  cursor?: string
  hasMore: boolean
  /** The served URL that a pathname is appended to, such as `/api/_vitehub/blob/`, or null when the store is not served. */
  served: string | null
  store: string
  /** True when a search stopped after scanning its limit of files. */
  truncated?: boolean
}

interface MediaContext {
  access: ConsoleMediaAccess
  served: string | null
  storage: BlobStorage
  store: string
}

function failure(status: 400 | 403 | 404 | 409 | 413 | 422, code: string, message: string): Error {
  return consoleActionError({ code, message, status })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function text(value: unknown, name: string): string {
  if (String(value) !== value || !value.trim()) throw failure(400, "MEDIA_INPUT", `${name} must be a non-empty string.`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, name)
}

function textList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw failure(400, "MEDIA_INPUT", `${name} must be a non-empty list.`)
  if (value.length > maximumBulk) throw failure(400, "MEDIA_INPUT", `${name} must list at most ${maximumBulk} entries.`)
  return [...new Set(value.map(entry => text(entry, name)))]
}

/** `posts/2026/` → `posts/2026`. */
function folderPath(value: string): string {
  return value.replace(/^\/+|\/+$/g, "")
}

function baseName(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf("/") + 1)
}

function parentFolder(pathname: string): string {
  const index = pathname.lastIndexOf("/")
  return index === -1 ? "" : pathname.slice(0, index)
}

/**
 * A file or folder name that works in a URL and in Markdown without escaping: ASCII letters, digits, `.`, `_`, and `-`.
 * `Launch Day (final).PNG` becomes `launch-day-final.png`.
 */
export function consoleMediaName(value: string): string {
  const name = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
  return name.replace(/-+\./g, ".")
}

function fileName(value: string): string {
  const name = consoleMediaName(baseName(value.replace(/\\/g, "/")))
  if (!name || name === ".keep") throw failure(400, "MEDIA_INPUT", "Name the file with letters or digits.")
  return name
}

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name
}

export function consoleMediaType(contentType: string): ConsoleMediaType {
  const type = contentType.split(";")[0]!.trim().toLowerCase()
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "application/pdf" || type.startsWith("text/") || /(?:msword|officedocument|opendocument|rtf|epub)/.test(type)) return "document"
  return "other"
}

function mediaFile(record: MediaRecord): ConsoleMediaFile {
  const { etag: _etag, hash: _hash, ...file } = record
  return { ...file, name: baseName(record.pathname) }
}

function isHiddenFolder(folder: string): boolean {
  const root = folderPath(folder).split("/")[0] ?? ""
  return hiddenRootFolders.has(root.toLowerCase())
}

/** Pathnames under `_vitehub/` or a hidden root folder, which the library never shows. */
function isReservedPath(pathname: string): boolean {
  const root = pathname.split("/", 1)[0]!.toLowerCase()
  return root === "_vitehub" || hiddenRootFolders.has(root)
}

function normalizedMediaPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "")
  }
  catch {
    return pathname.replace(/^\/+/, "")
  }
}

function checkedMutationPath(pathname: string): string {
  const parts: string[] = []
  for (const part of pathname.replaceAll("\\", "/").split("/")) {
    if (part === "..") {
      if (!parts.length) throw failure(400, "MEDIA_INPUT", "This path escapes the media store.")
      parts.pop()
    }
    else if (part && part !== ".") parts.push(part)
  }
  const normalized = parts.join("/")
  if (!normalized || isReservedPath(normalized) || isHiddenFolder(normalized)) {
    throw failure(400, "MEDIA_INPUT", "This path is reserved for ViteHub.")
  }
  return normalized
}

/** Turns a Blob failure into a Console failure with a status the library shows. */
function unwrap<T>(result: BlobResult<T>): T {
  const [error, value] = result
  if (!error) return value
  if (error.code === "BLOB_NOT_FOUND") throw failure(404, error.code, error.message)
  if (error.code === "BLOB_CONFLICT") throw failure(409, error.code, error.message)
  throw error
}

/** Blob input diagnostics, such as a reserved pathname or an invalid crop, describe the request. */
async function blobCall<T>(call: () => Promise<BlobResult<T>>): Promise<T> {
  try {
    return unwrap(await call())
  }
  catch (error) {
    const code: unknown = Reflect.get(Object(error), "code")
    if (String(code) === code && /^BLOB_R\d+$/.test(code)) throw failure(400, code, error instanceof Error ? error.message : "Invalid media request.")
    throw error
  }
}

function joinUrl(base: string, route: string): string {
  const head = base.replace(/\/+$/, "")
  const tail = route.replace(/^\/+|\/+$/g, "")
  return `${head}/${tail}/`.replace(/^\/\//, "/")
}

/** The served Blob Store, or `default` when `blob.serve` is off. */
async function mediaStore(): Promise<{ served: string | null, storage: BlobStorage, store: string }> {
  const inspection = getConsoleBlob()
  const config = await getBlobRuntimeConfig().catch(() => false as const)
  const serve = config ? config.serve : undefined
  const store = serve && inspection.stores.includes(serve.store) ? serve.store : "default"
  const storage = store === "default" ? inspection.storage : inspection.storage.store(store)
  return { served: serve ? joinUrl(serve.publicBaseUrl || "/", serve.route) : null, storage, store }
}

async function mediaContext(section: string, access: ConsoleAccess): Promise<MediaContext & { section: string }> {
  if (!consoleAccessAllows(access, section)) throw consoleRequestError(403, "This Console access does not include this section.")
  if (!getConsoleSections().includes("blob")) throw consoleRequestError(404, "The media library needs Blob. Enable Blob in the ViteHub config.")
  const actions = await loadConsoleDocumentActions(section)
  const context = await consoleDocumentActionContext(access)
  const granted = await runConsoleDocumentAction(() => actions.mediaAccess(context))
  const mediaAccess: ConsoleMediaAccess = { manage: granted.manage === true, read: granted.read === true, write: granted.write === true }
  if (!mediaAccess.read) throw failure(403, "MEDIA_FORBIDDEN", "You cannot open the media library.")
  return { ...await mediaStore(), access: mediaAccess, section }
}

function requireAccess(context: MediaContext, level: "manage" | "write"): void {
  if (context.access[level]) return
  throw failure(403, "MEDIA_FORBIDDEN", level === "write"
    ? "You cannot change media. Ask for write access to a collection."
    : "Moving and deleting media changes published documents. Ask for publish access.")
}

function focalPoint(value: unknown, name: string): MediaFocalPoint | null | undefined {
  if (value === undefined || value === null) return value
  if (!isRecord(value) || Number(value.x) !== value.x || Number(value.y) !== value.y) throw failure(400, "MEDIA_INPUT", `${name} must be { x, y }.`)
  return { x: value.x, y: value.y }
}

/** A name that does not exist yet in the folder: `cover.jpg`, then `cover-2.jpg`, `cover-3.jpg`, … */
async function freePathname(storage: BlobStorage, folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  for (let attempt = 1; attempt < 1_000; attempt++) {
    const candidate = joinPath(folder, attempt === 1 ? name : `${stem}-${attempt}${extension}`)
    if (!unwrap(await storage.head(candidate))) return candidate
  }
  throw failure(409, "BLOB_CONFLICT", `Too many files named ${name} in this folder.`)
}

async function list(context: MediaContext, input: Record<string, unknown>): Promise<ConsoleMediaListing> {
  const folder = folderPath(optionalText(input.folder, "folder") ?? "")
  if (folder && isHiddenFolder(folder)) throw failure(404, "MEDIA_NOT_FOUND", "This media folder does not exist.")
  const search = optionalText(input.search, "search")?.trim().toLowerCase()
  const type = optionalText(input.type, "type")
  if (type && !["image", "video", "audio", "document", "other"].includes(type)) throw failure(400, "MEDIA_INPUT", "type must be image, video, audio, document, or other.")
  const cursor = optionalText(input.cursor, "cursor")
  const prefix = folder ? `${folder}/` : ""
  const matches = (file: ConsoleMediaFile) => (!type || consoleMediaType(file.contentType) === type) && (!search || file.name.toLowerCase().includes(search))
  const base = { access: context.access, folder, served: context.served, store: context.store }
  if (search) {
    // Search file names in every folder below this one. Raw listings avoid a record read per scanned file; only the
    // matches load their media records.
    const found: string[] = []
    let scanned = 0
    let next: string | undefined
    do {
      const page = await blobCall(() => context.storage.list({ folded: false, limit: 1_000, prefix, ...(next ? { cursor: next } : {}) }))
      scanned += page.blobs.length
      for (const object of page.blobs) {
        const name = baseName(object.pathname)
        if (name === ".keep" || isReservedPath(object.pathname) || !name.toLowerCase().includes(search)) continue
        if (type && consoleMediaType(object.contentType ?? "") !== type) continue
        found.push(object.pathname)
      }
      next = page.hasMore ? page.cursor : undefined
    } while (next && scanned < searchScanLimit && found.length < searchResultLimit)
    const records = await Promise.all(found.slice(0, searchResultLimit).map(pathname => blobCall(() => context.storage.media.get(pathname))))
    const items = records.flatMap(record => record ? [mediaFile(record)] : [])
    return { ...base, folders: [], hasMore: false, items, ...(next ? { truncated: true } : {}) }
  }
  const page = await blobCall(() => context.storage.media.list({ folded: true, limit: listLimit, prefix, ...(cursor ? { cursor } : {}) }))
  const folders = page.folders.map(entry => folderPath(entry)).filter(entry => !(folder === "" && isHiddenFolder(entry))).sort((left, right) => left.localeCompare(right))
  const listing: ConsoleMediaListing = {
    ...base,
    folders: cursor ? [] : folders,
    hasMore: page.hasMore,
    items: page.items.map(mediaFile).filter(matches),
  }
  if (page.hasMore && page.cursor) listing.cursor = page.cursor
  return listing
}

async function get(context: MediaContext, input: Record<string, unknown>): Promise<ConsoleMediaFile> {
  const pathname = normalizedMediaPath(text(input.pathname, "pathname"))
  if (isHiddenFolder(pathname)) throw failure(404, "BLOB_NOT_FOUND", "This file no longer exists.")
  const record = await blobCall(() => context.storage.media.get(pathname))
  if (!record) throw failure(404, "BLOB_NOT_FOUND", "This file no longer exists.")
  return mediaFile(record)
}

async function update(context: MediaContext, input: Record<string, unknown>): Promise<ConsoleMediaFile> {
  requireAccess(context, "write")
  const pathname = checkedMutationPath(text(input.pathname, "pathname"))
  const patch: MediaUpdate = {}
  for (const key of ["alt", "caption"] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (value !== null && String(value) !== value) throw failure(400, "MEDIA_INPUT", `${key} must be a string or null.`)
    // An empty field removes the text.
    patch[key] = value === null || !value.trim() ? null : value
  }
  const focal = focalPoint(input.focal, "focal")
  if (focal !== undefined) patch.focal = focal
  if (input.crops !== undefined) {
    if (!isRecord(input.crops)) throw failure(400, "MEDIA_INPUT", "crops must be an object of named crops.")
    const crops: NonNullable<MediaUpdate["crops"]> = {}
    for (const [name, crop] of Object.entries(input.crops)) {
      if (crop === null) {
        crops[name] = null
        continue
      }
      if (!isRecord(crop)) throw failure(400, "MEDIA_INPUT", `Crop ${name} must be { aspect, focal? }.`)
      const cropFocal = focalPoint(crop.focal, `Crop ${name} focal`)
      crops[name] = cropFocal === undefined ? { aspect: text(crop.aspect, "aspect") } : { aspect: text(crop.aspect, "aspect"), focal: cropFocal }
    }
    patch.crops = crops
  }
  return mediaFile(await blobCall(() => context.storage.media.update(pathname, patch)))
}

async function removeCropReplacement(context: MediaContext, input: Record<string, unknown>): Promise<ConsoleMediaFile> {
  requireAccess(context, "write")
  return mediaFile(await blobCall(() => context.storage.media.replaceCrop(checkedMutationPath(text(input.pathname, "pathname")), text(input.crop, "crop"), null)))
}

interface BulkFailure {
  message: string
  pathname: string
}

function bulkFailure(pathname: string, error: unknown): BulkFailure {
  return { message: error instanceof Error ? error.message : "The change failed.", pathname }
}

/** Moves files into a folder, or renames one file when `to` is a pathname. */
async function move(context: MediaContext, input: Record<string, unknown>): Promise<{ failed: BulkFailure[], moved: ConsoleMediaFile[] }> {
  requireAccess(context, "manage")
  if (!Array.isArray(input.moves) || !input.moves.length || input.moves.length > maximumBulk) {
    throw failure(400, "MEDIA_INPUT", `move() requires { moves: [{ from, to }] } with 1 to ${maximumBulk} entries.`)
  }
  const moves = input.moves.map((entry: unknown) => {
    if (!isRecord(entry)) throw failure(400, "MEDIA_INPUT", "Each move must be { from, to }.")
    const from = checkedMutationPath(text(entry.from, "from"))
    const target = text(entry.to, "to")
    const to = checkedMutationPath(joinPath(folderPath(parentFolder(target)), fileName(target)))
    return { from, to }
  })
  const moved: ConsoleMediaFile[] = []
  const failed: BulkFailure[] = []
  for (const { from, to } of moves) {
    try {
      moved.push(mediaFile(await blobCall(() => context.storage.media.move(from, to))))
    }
    catch (error) {
      failed.push(bulkFailure(from, error))
    }
  }
  return { failed, moved }
}

async function remove(context: MediaContext, input: Record<string, unknown>): Promise<{ failed: BulkFailure[], removed: string[] }> {
  requireAccess(context, "manage")
  const pathnames = textList(input.pathnames, "pathnames")
  // Validate the complete request before starting the partial-failure loop. An
  // escaping pathname is invalid input, rather than an item-level Blob failure.
  const checkedPathnames = pathnames.map(pathname => checkedMutationPath(pathname))
  const removed: string[] = []
  const failed: BulkFailure[] = []
  for (const [index, pathname] of pathnames.entries()) {
    try {
      await blobCall(() => context.storage.media.remove(checkedPathnames[index]!))
      removed.push(pathname)
    }
    catch (error) {
      failed.push(bulkFailure(pathname, error))
    }
  }
  return { failed, removed }
}

async function createFolder(context: MediaContext, input: Record<string, unknown>): Promise<{ path: string }> {
  requireAccess(context, "write")
  const rawParent = folderPath(optionalText(input.parent, "parent") ?? "")
  const parent = rawParent ? checkedMutationPath(rawParent) : ""
  const rawName = text(input.name, "name")
  // Check the client pathname before URL-safe normalization, which otherwise
  // strips a leading "../" and silently redirects the write into the root.
  checkedMutationPath(joinPath(parent, rawName))
  const name = consoleMediaName(rawName)
  if (!name) throw failure(400, "MEDIA_INPUT", "Name the folder with letters or digits.")
  const path = checkedMutationPath(joinPath(parent, name))
  await blobCall(() => context.storage.media.createFolder(path))
  return { path }
}

async function moveFolder(context: MediaContext, input: Record<string, unknown>): Promise<{ moved: number, path: string }> {
  requireAccess(context, "manage")
  const from = checkedMutationPath(folderPath(text(input.from, "from")))
  const segments = folderPath(text(input.to, "to")).split("/")
  const name = consoleMediaName(segments.pop() ?? "")
  if (!name) throw failure(400, "MEDIA_INPUT", "Name the folder with letters or digits.")
  const path = checkedMutationPath(joinPath(segments.join("/"), name))
  const result = await blobCall(() => context.storage.media.moveFolder(from, path))
  return { ...result, path }
}

async function removeFolder(context: MediaContext, input: Record<string, unknown>): Promise<{ removed: number }> {
  requireAccess(context, "manage")
  return await blobCall(() => context.storage.media.removeFolder(checkedMutationPath(folderPath(text(input.path, "path"))), { force: input.force === true }))
}

async function usage(section: string, access: ConsoleAccess, input: Record<string, unknown>): Promise<unknown> {
  const actions = await loadConsoleDocumentActions(section)
  const context = await consoleDocumentActionContext(access)
  return await runConsoleDocumentAction(() => actions.references({ pathnames: textList(input.pathnames, "pathnames") }, context))
}

function isActionName(value: unknown): value is ConsoleMediaActionName {
  return consoleMediaActionNames.some(name => name === value)
}

/** Runs one media library action for a section that the access includes. */
export async function runConsoleMediaAction(section: string, action: unknown, input: unknown, access: ConsoleAccess): Promise<unknown> {
  if (!isActionName(action)) throw consoleRequestError(400, "A valid media action is required.")
  const body = isRecord(input) ? input : {}
  const context = await mediaContext(section, access)
  switch (action) {
    case "info": return { access: context.access, served: context.served, store: context.store } satisfies ConsoleMediaInfo
    case "list": return await list(context, body)
    case "get": return await get(context, body)
    case "update": return await update(context, body)
    case "removeCropReplacement": return await removeCropReplacement(context, body)
    case "move": return await move(context, body)
    case "remove": return await remove(context, body)
    case "createFolder": return await createFolder(context, body)
    case "moveFolder": return await moveFolder(context, body)
    case "removeFolder": return await removeFolder(context, body)
    case "usage": return await usage(section, access, body)
  }
}

const tooLarge = () => failure(413, "MEDIA_TOO_LARGE", `Files must be smaller than ${maximumConsoleMediaUploadBytes / 1024 / 1024} MB.`)

/** Reads a `multipart/form-data` body, refusing more than the upload limit before it is all in memory. */
async function boundedForm(request: Request): Promise<FormData> {
  const length = Number(request.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(length) && length > maximumConsoleMediaUploadBytes) throw tooLarge()
  const type = request.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("multipart/form-data") || !request.body) throw consoleRequestError(400, "Send the upload as multipart/form-data.")
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = request.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maximumConsoleMediaUploadBytes) {
      await reader.cancel()
      throw tooLarge()
    }
    chunks.push(chunk.value)
  }
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData()
  }
  catch {
    throw consoleRequestError(400, "Send the upload as multipart/form-data.")
  }
}

/** The result of one upload: the stored file, and whether the store already held the same bytes elsewhere. */
export interface ConsoleMediaUpload {
  /** The store already held these bytes, so `file` is the existing copy, possibly in another folder. */
  duplicate: boolean
  file: ConsoleMediaFile
}

/**
 * Stores one uploaded file from a `multipart/form-data` request: `file` and `folder` for a new file, or `file`,
 * `pathname`, and `crop` for the replacement image of one crop, such as a portrait version for phones.
 */
export async function uploadConsoleMedia(request: Request, section: string, access: ConsoleAccess): Promise<ConsoleMediaUpload> {
  const context = await mediaContext(section, access)
  requireAccess(context, "write")
  const form = await boundedForm(request)
  const file = form.get("file")
  if (!(file instanceof File)) throw failure(400, "MEDIA_INPUT", "The upload has no file.")
  const crop = form.get("crop")
  const pathname = form.get("pathname")
  if (String(crop) === crop && crop) {
    if (String(pathname) !== pathname || !pathname) throw failure(400, "MEDIA_INPUT", "A crop replacement needs the pathname of the original.")
    const record = await blobCall(() => context.storage.media.replaceCrop(checkedMutationPath(pathname), crop, file))
    return { duplicate: false, file: mediaFile(record) }
  }
  const folderValue = form.get("folder")
  const rawFolder = folderPath(String(folderValue) === folderValue ? folderValue : "")
  const folder = rawFolder ? checkedMutationPath(rawFolder) : ""
  const target = await freePathname(context.storage, folder, fileName(file.name || "file"))
  const record = await blobCall(() => context.storage.media.put(target, file, { dedupe: true, ...(file.type ? { contentType: file.type } : {}) }))
  return { duplicate: record.pathname !== target, file: mediaFile(record) }
}
