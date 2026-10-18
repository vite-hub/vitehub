// Media records: per-object metadata stored as JSON sidecars in the same Blob Store, plus folders and image variants.
import { createError } from "h3"

import { ensureBlob } from "../ensure.ts"
import { blobError } from "../errors.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import { averageImageColor } from "./color.ts"
import { probeImage } from "./probe.ts"
import { selectImageTransformer } from "./transformers.ts"
import { isMediaCropName, isMediaFocalPoint, parseAspectRatio, resolveImageGeometry } from "./variant.ts"

import type { ResolvedBlobImages } from "./transformers.ts"
import type { MediaCrop, MediaCropReplacement, MediaRecord, MediaUpdate, MediaVariantEntry } from "./types.ts"
import type { BlobImageVariant, MediaFocalPoint } from "./variant.ts"
import type {
  BlobDriverAdapter,
  BlobErrorCode,
  BlobMedia,
  BlobMediaListResult,
  BlobMediaPutOptions,
  BlobObject,
  BlobPutBody,
  BlobResult,
  BlobServeResponseOptions,
  BlobStorage,
} from "../types.ts"

/** Reserved prefix of media records. A record for `posts/cover.jpg` lives at `_vitehub/media/records/posts/cover.jpg.json`. */
export const mediaRecordsPrefix = "_vitehub/media/records/"
/** Reserved prefix of crop replacement files. */
export const mediaCropsPrefix = "_vitehub/media/crops/"
/** Reserved prefix of the content-hash index used for deduplication. */
export const mediaHashesPrefix = "_vitehub/media/hashes/"
/** Empty object that keeps an otherwise empty folder visible. */
export const mediaFolderMarker = ".keep"

const transformableTypes = new Set(["image/avif", "image/jpeg", "image/png", "image/webp"])
const formatExtensions = new Map([["avif", ".avif"], ["gif", ".gif"], ["jpeg", ".jpg"], ["png", ".png"], ["svg", ".svg"], ["webp", ".webp"]])

export interface BlobMediaContext {
  clearDerived(pathname: string): Promise<void>
  derivedPrefix(pathname: string): Promise<string>
  driver: BlobDriverAdapter<unknown>
  images: ResolvedBlobImages | undefined
  normalizePathname(pathname: string): string
  storage: Pick<BlobStorage, "del" | "list" | "put">
  store: string
  url?: (pathname: string) => string | undefined | Promise<string | undefined>
}

/** A planned image variant: the pathname to read and the transform that the derived cache stores. */
export interface MediaVariantPlan {
  source: string
  transform: NonNullable<BlobServeResponseOptions["transform"]>
}

export interface InternalBlobMedia extends BlobMedia {
  planVariant(pathname: string, variant: BlobImageVariant): Promise<MediaVariantPlan | undefined>
}

class MediaFailure extends Error {
  constructor(readonly code: BlobErrorCode, message: string, readonly result?: BlobResult<unknown>[0]) {
    super(message)
  }
}

function invalid(message: string): Error {
  return blobErrorDiagnostics.BLOB_R0035({ message })
}

function isString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Records come from stored JSON.
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Records come from stored JSON.
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && Object(value) === value
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function toBytes(body: BlobPutBody): Promise<Uint8Array<ArrayBuffer>> {
  if (isString(body)) return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  // Copy views, so a view over a shared or larger buffer hashes and stores only its own bytes.
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  // SAFETY: Blob put bodies stream bytes, which is what a Response body reads.
  return new Uint8Array(await new Response(body as ReadableStream<Uint8Array>).arrayBuffer())
}

function gcd(left: number, right: number): number {
  return right ? gcd(right, left % right) : left
}

function reducedAspect(width: number, height: number): string {
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function baseName(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf("/") + 1)
}

function isReservedPathname(pathname: string): boolean {
  const [first, second] = pathname.split("/")
  return first?.toLowerCase() === "_vitehub" && (second === undefined || ["derived", "media"].includes(second.toLowerCase()))
}

function sanitizeFocal(value: unknown): MediaFocalPoint | undefined {
  return isMediaFocalPoint(value) ? { x: value.x, y: value.y } : undefined
}

function sanitizeReplacement(value: unknown): MediaCropReplacement | undefined {
  if (!isRecord(value) || !isString(value.pathname) || !isString(value.contentType) || !isString(value.hash) || !isNumber(value.size)) return undefined
  const replacement: MediaCropReplacement = { contentType: value.contentType, hash: value.hash, pathname: value.pathname, size: value.size }
  if (isNumber(value.width)) replacement.width = value.width
  if (isNumber(value.height)) replacement.height = value.height
  return replacement
}

function sanitizeCrops(value: unknown): Record<string, MediaCrop> | undefined {
  if (!isRecord(value)) return undefined
  const crops: Record<string, MediaCrop> = {}
  for (const [name, crop] of Object.entries(value)) {
    if (!isMediaCropName(name) || !isRecord(crop) || !isString(crop.aspect) || !parseAspectRatio(crop.aspect)) continue
    const next: MediaCrop = { aspect: crop.aspect }
    const focal = sanitizeFocal(crop.focal)
    const replacement = sanitizeReplacement(crop.replacement)
    if (focal) next.focal = focal
    if (replacement) next.replacement = replacement
    crops[name] = next
  }
  return Object.keys(crops).length ? crops : undefined
}

/** Reads a stored record and drops fields that do not have the expected shape. */
export function sanitizeMediaRecord(value: unknown): MediaRecord | undefined {
  if (!isRecord(value) || !isString(value.pathname) || !isString(value.contentType) || !isNumber(value.size)) return undefined
  const now = new Date(0).toISOString()
  const record: MediaRecord = {
    contentType: value.contentType,
    createdAt: isString(value.createdAt) ? value.createdAt : now,
    pathname: value.pathname,
    size: value.size,
    updatedAt: isString(value.updatedAt) ? value.updatedAt : now,
  }
  for (const key of ["alt", "caption", "color", "etag", "hash"] as const) {
    const field = value[key]
    if (isString(field)) record[key] = field
  }
  if (isNumber(value.width)) record.width = value.width
  if (isNumber(value.height)) record.height = value.height
  const focal = sanitizeFocal(value.focal)
  const crops = sanitizeCrops(value.crops)
  if (focal) record.focal = focal
  if (crops) record.crops = crops
  return record
}

function assertFocal(focal: unknown, label: string): void {
  if (focal !== undefined && focal !== null && !isMediaFocalPoint(focal)) {
    throw invalid(`${label} must be { x, y } with each value from 0 to 1.`)
  }
}

function assertCropInput(name: string, crop: unknown): void {
  if (!isMediaCropName(name)) throw invalid(`Crop name "${name}" must use letters, digits, "_" or "-", start with a letter or digit, and have at most 64 characters.`)
  if (crop === null) return
  if (!isRecord(crop) || !isString(crop.aspect) || !parseAspectRatio(crop.aspect)) {
    throw invalid(`Crop "${name}" needs an aspect such as "4:5" or "16:9".`)
  }
  assertFocal(crop.focal, `Crop "${name}" focal`)
}

function assertUpdate(patch: MediaUpdate): void {
  if (!isRecord(patch)) throw invalid("Media update must be an object.")
  for (const key of ["alt", "caption"] as const) {
    if (patch[key] !== undefined && patch[key] !== null && !isString(patch[key])) throw invalid(`Media ${key} must be a string or null.`)
  }
  assertFocal(patch.focal, "Media focal")
  if (patch.crops !== undefined) {
    if (!isRecord(patch.crops)) throw invalid("Media crops must be an object of named crops.")
    for (const [name, crop] of Object.entries(patch.crops)) assertCropInput(name, crop)
  }
}

function isFresh(record: MediaRecord, object: BlobObject): boolean {
  if (record.hash === undefined || record.contentType !== (object.contentType ?? record.contentType)) return false
  return object.httpEtag ? record.etag === object.httpEtag : record.size === object.size
}

/** Keeps editorial fields from a record whose probed fields no longer describe the object. */
function editorialFields(record: MediaRecord | undefined): Pick<MediaRecord, "alt" | "caption" | "crops" | "focal"> {
  if (!record) return {}
  return {
    ...(record.alt !== undefined ? { alt: record.alt } : {}),
    ...(record.caption !== undefined ? { caption: record.caption } : {}),
    ...(record.crops ? { crops: record.crops } : {}),
    ...(record.focal ? { focal: record.focal } : {}),
  }
}

function objectRecord(object: BlobObject, previous: MediaRecord | undefined): MediaRecord {
  const createdAt = previous?.createdAt ?? object.uploadedAt.toISOString()
  return {
    ...editorialFields(previous),
    contentType: object.contentType ?? previous?.contentType ?? "application/octet-stream",
    createdAt,
    pathname: object.pathname,
    size: object.size ?? previous?.size ?? 0,
    updatedAt: previous?.updatedAt ?? createdAt,
  }
}

function applyCropPatch(crops: Record<string, MediaCrop> | undefined, patch: NonNullable<MediaUpdate["crops"]>): { crops: Record<string, MediaCrop> | undefined, removed: MediaCropReplacement[] } {
  const next = { ...crops }
  const removed: MediaCropReplacement[] = []
  for (const [name, crop] of Object.entries(patch)) {
    const existing = next[name]
    if (crop === null) {
      if (existing?.replacement) removed.push(existing.replacement)
      delete next[name]
      continue
    }
    const merged: MediaCrop = { aspect: crop.aspect }
    const focal = crop.focal === undefined ? existing?.focal : crop.focal ?? undefined
    if (focal) merged.focal = { x: focal.x, y: focal.y }
    if (existing?.replacement) merged.replacement = existing.replacement
    next[name] = merged
  }
  return { crops: Object.keys(next).length ? next : undefined, removed }
}

export function createBlobMedia(context: BlobMediaContext): InternalBlobMedia {
  const { driver, images, store } = context
  const canonical = (pathname: string) => driver.canonicalPathname?.(pathname) ?? pathname
  const recordPath = (pathname: string) => `${mediaRecordsPrefix}${canonical(pathname)}.json`
  const hashPath = (hash: string) => `${mediaHashesPrefix}${hash}.json`

  async function run<TResult>(operation: () => Promise<TResult>): Promise<BlobResult<TResult>> {
    try {
      return [null, await operation()]
    }
    catch (cause) {
      if (cause instanceof MediaFailure) {
        return [cause.result ?? blobError(cause.code, "media", store, new Error(cause.message)), undefined]
      }
      if (cause instanceof Error && "code" in cause && /^BLOB_R00(?:33|35)$/.test(String(cause.code))) throw cause
      return [blobError("BLOB_OPERATION_FAILED", "media", store, cause), undefined]
    }
  }

  function unwrap<TResult>(result: BlobResult<TResult>): TResult {
    const [error, value] = result
    if (error) throw new MediaFailure(error.code, error.message, error)
    return value
  }

  async function withUrl(record: MediaRecord): Promise<MediaRecord> {
    const url = await context.url?.(record.pathname)
    return url ? { ...record, url } : record
  }

  async function readJson(pathname: string): Promise<unknown> {
    const body = await driver.get(pathname)
    if (!body) return undefined
    try {
      return JSON.parse(await body.text())
    }
    catch {
      return undefined
    }
  }

  // Some providers forbid overwrites, so a failed write retries after removing the old object.
  async function writeJson(pathname: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value, null, 2)
    try {
      await driver.put(pathname, body, { contentType: "application/json" })
    }
    catch (error) {
      if (!await driver.head(pathname)) throw error
      await driver.delete([pathname])
      await driver.put(pathname, body, { contentType: "application/json" })
    }
  }

  async function readRecord(pathname: string): Promise<MediaRecord | undefined> {
    const record = sanitizeMediaRecord(await readJson(recordPath(pathname)))
    return record && canonical(record.pathname) === canonical(pathname) ? record : undefined
  }

  async function writeRecord(record: MediaRecord): Promise<void> {
    const { url: _url, ...stored } = record
    await writeJson(recordPath(record.pathname), stored)
  }

  async function analyze(bytes: Uint8Array<ArrayBuffer>, contentType: string | undefined) {
    const probe = probeImage(bytes)
    const hash = await sha256(bytes)
    let color: string | undefined
    const type = (contentType || probe?.contentType || "").split(";")[0]!.trim().toLowerCase()
    if (probe && images && (transformableTypes.has(type) || type === "image/gif")) {
      const transformer = await selectImageTransformer(images).catch(() => undefined)
      if (transformer) color = await averageImageColor(transformer, new Blob([bytes], { type }))
    }
    return { color, hash, probe }
  }

  function probed(record: MediaRecord, object: BlobObject, analysis: Awaited<ReturnType<typeof analyze>>): MediaRecord {
    const next: MediaRecord = { ...record, hash: analysis.hash }
    delete next.width
    delete next.height
    delete next.color
    if (object.httpEtag) next.etag = object.httpEtag
    else delete next.etag
    if (analysis.probe) {
      next.width = analysis.probe.width
      next.height = analysis.probe.height
    }
    if (analysis.color) next.color = analysis.color
    return next
  }

  /** Returns the record for an object, reading the object again when the stored record is missing or stale. */
  async function load(pathname: string): Promise<MediaRecord | null> {
    const object = await driver.head(pathname)
    if (!object) return null
    const stored = await readRecord(pathname)
    if (stored && isFresh(stored, object)) return stored
    const bytes = await driver.getArrayBuffer(pathname)
    if (!bytes) return null
    const record = probed(objectRecord(object, stored), object, await analyze(new Uint8Array(bytes), object.contentType))
    try {
      await writeRecord(record)
    }
    catch (error) {
      console.error("[vitehub/blob] Media record write failed", error)
    }
    return record
  }

  async function requireRecord(pathname: string): Promise<MediaRecord> {
    const record = await load(pathname)
    if (!record) throw new MediaFailure("BLOB_NOT_FOUND", `Blob ${pathname} was not found in store ${store}.`)
    return record
  }

  async function findByHash(hash: string): Promise<MediaRecord | undefined> {
    const entry = await readJson(hashPath(hash))
    if (!isRecord(entry) || !isString(entry.pathname)) return undefined
    const record = await load(entry.pathname)
    return record?.hash === hash ? record : undefined
  }

  async function removeReplacement(replacement: MediaCropReplacement): Promise<void> {
    await driver.delete([replacement.pathname])
    await context.clearDerived(replacement.pathname)
  }

  async function cropPath(pathname: string, name: string, hash: string, format: string): Promise<string> {
    const owner = await sha256(new TextEncoder().encode(canonical(pathname)))
    return `${mediaCropsPrefix}${owner.slice(0, 32)}/${name}.${hash.slice(0, 12)}${formatExtensions.get(format) ?? ""}`
  }

  async function copyObject(from: string, to: string, object: BlobObject): Promise<BlobObject> {
    const body = await driver.get(from)
    if (!body) throw new MediaFailure("BLOB_NOT_FOUND", `Blob ${from} was not found in store ${store}.`)
    const customMetadata = Object.keys(object.customMetadata).length ? { customMetadata: object.customMetadata } : {}
    return unwrap(await context.storage.put(to, body, { ...(object.contentType ? { contentType: object.contentType } : {}), ...customMetadata }))
  }

  async function removeMedia(pathname: string): Promise<void> {
    const record = await readRecord(pathname)
    unwrap(await context.storage.del(pathname))
    for (const crop of Object.values(record?.crops ?? {})) {
      if (crop.replacement) await removeReplacement(crop.replacement)
    }
    await driver.delete([recordPath(pathname)])
    if (record?.hash) {
      const entry = await readJson(hashPath(record.hash))
      if (isRecord(entry) && entry.pathname === pathname) await driver.delete([hashPath(record.hash)])
    }
  }

  async function moveMedia(from: string, to: string, overwrite: boolean): Promise<MediaRecord> {
    const object = await driver.head(from)
    if (!object) throw new MediaFailure("BLOB_NOT_FOUND", `Blob ${from} was not found in store ${store}.`)
    if (canonical(from) === canonical(to)) return await requireRecord(from)
    if (!overwrite && await driver.head(to)) throw new MediaFailure("BLOB_CONFLICT", `Blob ${to} already exists in store ${store}.`)
    if (overwrite && await driver.head(to)) await removeMedia(to)
    const record = await requireRecord(from)
    const moved = await copyObject(from, to, object)
    let crops: Record<string, MediaCrop> | undefined
    for (const [name, crop] of Object.entries(record.crops ?? {})) {
      crops ||= {}
      if (!crop.replacement) {
        crops[name] = crop
        continue
      }
      const path = await cropPath(moved.pathname, name, crop.replacement.hash, probeFormat(crop.replacement.contentType))
      const body = await driver.get(crop.replacement.pathname)
      if (body) await driver.put(path, body, { contentType: crop.replacement.contentType })
      crops[name] = { ...crop, replacement: { ...crop.replacement, pathname: path } }
    }
    const next: MediaRecord = { ...record, pathname: moved.pathname, size: moved.size ?? record.size, updatedAt: new Date().toISOString() }
    if (moved.httpEtag) next.etag = moved.httpEtag
    else delete next.etag
    if (crops) next.crops = crops
    await context.clearDerived(moved.pathname)
    await writeRecord(next)
    if (next.hash) await writeJson(hashPath(next.hash), { pathname: next.pathname })
    unwrap(await context.storage.del(from))
    for (const crop of Object.values(record.crops ?? {})) {
      if (crop.replacement) await removeReplacement(crop.replacement)
    }
    await driver.delete([recordPath(from)])
    return next
  }

  function probeFormat(contentType: string): string {
    return contentType.split(";")[0]!.trim().toLowerCase().replace(/^image\//, "").replace("svg+xml", "svg")
  }

  function normalizeTarget(pathname: string): string {
    const normalized = driver.canonicalPathname?.(context.normalizePathname(pathname)) ?? context.normalizePathname(pathname)
    if (!normalized || normalized.endsWith("/")) throw invalid("Media pathname must name a file, not a folder.")
    if (isReservedPathname(normalized)) throw blobErrorDiagnostics.BLOB_R0033({ message: "Blob pathname uses a reserved ViteHub namespace." })
    return normalized
  }

  function normalizeFolder(path: string): string {
    const folder = (driver.canonicalPathname?.(context.normalizePathname(path)) ?? context.normalizePathname(path)).replace(/\/+$/, "")
    if (!folder) throw invalid("Media folder must not be the store root.")
    if (isReservedPathname(folder)) throw blobErrorDiagnostics.BLOB_R0033({ message: "Blob folder uses a reserved ViteHub namespace." })
    return folder
  }

  async function listAll(prefix: string): Promise<BlobObject[]> {
    const objects: BlobObject[] = []
    let cursor: string | undefined
    do {
      const page = unwrap(await context.storage.list({ prefix, ...(cursor ? { cursor } : {}) }))
      objects.push(...page.blobs)
      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
    return objects
  }

  async function putMedia(pathname: string, body: BlobPutBody, options: BlobMediaPutOptions = {}): Promise<MediaRecord> {
    const { alt, caption, crops, dedupe, focal, ...putOptions } = options
    assertFocal(focal, "Media focal")
    for (const [name, crop] of Object.entries(crops ?? {})) assertCropInput(name, crop)
    const bytes = await toBytes(body)
    const blobType = body instanceof Blob && body.type ? body.type : undefined
    const analysis = await analyze(bytes, putOptions.contentType ?? blobType)
    if (dedupe) {
      const existing = await findByHash(analysis.hash)
      if (existing) return existing
    }
    const contentType = putOptions.contentType ?? blobType ?? analysis.probe?.contentType
    const object = unwrap(await context.storage.put(pathname, bytes, { ...putOptions, ...(contentType ? { contentType } : {}) }))
    const previous = await readRecord(object.pathname)
    const now = new Date().toISOString()
    const record = probed({ ...objectRecord(object, previous), updatedAt: now }, object, analysis)
    if (!previous) record.createdAt = now
    if (alt !== undefined) record.alt = alt
    if (caption !== undefined) record.caption = caption
    if (focal) record.focal = { x: focal.x, y: focal.y }
    let removedReplacements: MediaCropReplacement[] = []
    if (crops) {
      const applied = applyCropPatch(record.crops, crops)
      record.crops = applied.crops
      removedReplacements = applied.removed
    }
    if (previous) await context.clearDerived(object.pathname)
    await writeRecord(record)
    for (const replacement of removedReplacements) await removeReplacement(replacement)
    await writeJson(hashPath(analysis.hash), { pathname: record.pathname })
    return record
  }

  const media: InternalBlobMedia = {
    get: pathname => run(async () => {
      const record = await load(normalizeTarget(isString(pathname) ? pathname : pathname.pathname))
      return record && await withUrl(record)
    }),
    put: (pathname, body, options) => run(async () => withUrl(await putMedia(normalizeTarget(pathname), body, options))),
    async handleUpload(event, options = {}) {
      const formKey = options.formKey ?? "files"
      let form: FormData
      try {
        form = await event.req.formData()
      }
      catch {
        throw createError({ statusCode: 400, message: "Expected a multipart/form-data request body." })
      }
      const files = form.getAll(formKey).filter((value): value is File => value instanceof File)
      if (!files.length) throw createError({ statusCode: 400, message: `No files in form field "${formKey}".` })
      if (options.multiple === false && files.length > 1) throw createError({ statusCode: 400, message: `Form field "${formKey}" accepts one file.` })
      if (options.ensure) {
        for (const file of files) ensureBlob(file, options.ensure)
      }
      const folder = options.folder ? normalizeFolder(options.folder) : undefined
      return run(async () => {
        const records: MediaRecord[] = []
        for (const file of files) {
          const name = file.name.split(/[\\/]/).pop() || "file"
          records.push(await withUrl(await putMedia(folder ? `${folder}/${name}` : name, file, { ...options.put, dedupe: options.dedupe ?? true })))
        }
        return records
      })
    },
    update: (pathname, patch) => run(async () => {
      assertUpdate(patch)
      const target = normalizeTarget(pathname)
      const record = await requireRecord(target)
      const next: MediaRecord = { ...record, updatedAt: new Date().toISOString() }
      for (const key of ["alt", "caption"] as const) {
        const value = patch[key]
        if (value === null) delete next[key]
        else if (value !== undefined) next[key] = value
      }
      if (patch.focal === null) delete next.focal
      else if (patch.focal) next.focal = { x: patch.focal.x, y: patch.focal.y }
      let removed: MediaCropReplacement[] = []
      if (patch.crops) {
        const applied = applyCropPatch(record.crops, patch.crops)
        removed = applied.removed
        if (applied.crops) next.crops = applied.crops
        else delete next.crops
      }
      await writeRecord(next)
      for (const replacement of removed) await removeReplacement(replacement)
      if (patch.focal !== undefined || patch.crops !== undefined) await context.clearDerived(target)
      return withUrl(next)
    }),
    replaceCrop: (pathname, name, body) => run(async () => {
      if (!isMediaCropName(name)) throw invalid(`Crop name "${name}" must use letters, digits, "_" or "-", start with a letter or digit, and have at most 64 characters.`)
      const target = normalizeTarget(pathname)
      const record = await requireRecord(target)
      const existing = record.crops?.[name]
      const next: MediaRecord = { ...record, crops: { ...record.crops }, updatedAt: new Date().toISOString() }
      if (body === null) {
        if (!existing) return withUrl(record)
        const { replacement, ...crop } = existing
        next.crops![name] = crop
        await writeRecord(next)
        if (replacement) await removeReplacement(replacement)
        return withUrl(next)
      }
      const bytes = await toBytes(body)
      const probe = probeImage(bytes)
      if (!probe || !transformableTypes.has(probe.contentType)) throw invalid(`Crop "${name}" replacement must be a JPEG, PNG, WebP, or AVIF image.`)
      const hash = await sha256(bytes)
      const path = await cropPath(target, name, hash, probe.format)
      await driver.put(path, bytes, { contentType: probe.contentType })
      const replacement: MediaCropReplacement = { contentType: probe.contentType, hash, height: probe.height, pathname: path, size: bytes.byteLength, width: probe.width }
      next.crops![name] = { ...existing, aspect: existing?.aspect ?? reducedAspect(probe.width, probe.height), replacement }
      await writeRecord(next)
      if (existing?.replacement && existing.replacement.pathname !== path) await removeReplacement(existing.replacement)
      return withUrl(next)
    }),
    list: (options = {}) => run(async () => {
      const limit = options.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid("Media list `limit` must be an integer from 1 to 1000.")
      const prefix = options.prefix ? context.normalizePathname(options.prefix) : ""
      const page = unwrap(await context.storage.list({ folded: options.folded ?? true, limit, prefix, ...(options.cursor ? { cursor: options.cursor } : {}) }))
      const objects = page.blobs.filter(object => !isReservedPathname(object.pathname) && baseName(object.pathname) !== mediaFolderMarker)
      const items = await Promise.all(objects.map(async (object) => {
        const stored = await readRecord(object.pathname)
        return withUrl(stored && isFresh(stored, object) ? stored : objectRecord(object, stored))
      }))
      const result: BlobMediaListResult = {
        folders: (page.folders ?? []).filter(folder => !isReservedPathname(folder.replace(/\/$/, ""))),
        hasMore: page.hasMore,
        items,
      }
      if (page.cursor) result.cursor = page.cursor
      return result
    }),
    move: (from, to, options = {}) => run(async () => withUrl(await moveMedia(normalizeTarget(from), normalizeTarget(to), options.overwrite ?? false))),
    remove: pathname => run(async () => {
      await removeMedia(normalizeTarget(pathname))
    }),
    createFolder: path => run(async () => {
      const folder = normalizeFolder(path)
      unwrap(await context.storage.put(`${folder}/${mediaFolderMarker}`, "", { contentType: "text/plain" }))
    }),
    removeFolder: (path, options = {}) => run(async () => {
      const folder = normalizeFolder(path)
      const objects = await listAll(`${folder}/`)
      const content = objects.filter(object => baseName(object.pathname) !== mediaFolderMarker)
      if (content.length && !options.force) throw new MediaFailure("BLOB_CONFLICT", `Folder ${folder}/ in store ${store} is not empty. Pass { force: true } to remove ${content.length} objects.`)
      for (const object of content) await removeMedia(object.pathname)
      const markers = objects.filter(object => baseName(object.pathname) === mediaFolderMarker).map(object => object.pathname)
      if (markers.length) unwrap(await context.storage.del(markers))
      return { removed: content.length }
    }),
    moveFolder: (from, to) => run(async () => {
      const source = normalizeFolder(from)
      const target = normalizeFolder(to)
      if (canonical(target) === canonical(source) || canonical(target).startsWith(`${canonical(source)}/`)) throw invalid(`Cannot move folder ${source}/ into itself.`)
      const objects = await listAll(`${source}/`)
      if (!objects.length) throw new MediaFailure("BLOB_NOT_FOUND", `Folder ${source}/ was not found in store ${store}.`)
      if ((await listAll(`${target}/`)).length) throw new MediaFailure("BLOB_CONFLICT", `Folder ${target}/ in store ${store} is not empty.`)
      let moved = 0
      for (const object of objects) {
        const destination = `${target}/${object.pathname.slice(source.length + 1)}`
        if (baseName(object.pathname) === mediaFolderMarker) {
          await copyObject(object.pathname, destination, object)
          unwrap(await context.storage.del(object.pathname))
          continue
        }
        await moveMedia(object.pathname, destination, false)
        moved++
      }
      return { moved }
    }),
    variants: pathname => run(async () => {
      const target = normalizeTarget(pathname)
      const record = await readRecord(target)
      const sources = [target, ...Object.values(record?.crops ?? {}).flatMap(crop => crop.replacement ? [crop.replacement.pathname] : [])]
      const entries: MediaVariantEntry[] = []
      for (const source of sources) {
        const prefix = await context.derivedPrefix(canonical(source))
        for (const object of await listAll(prefix)) {
          const entry: MediaVariantEntry = { cachePathname: object.pathname, size: object.size ?? 0, source }
          const body = await driver.get(object.pathname)
          if (body) {
            const header = new Uint8Array(await body.slice(0, 4096).arrayBuffer())
            const boundary = header.indexOf(10)
            try {
              const metadata: unknown = JSON.parse(new TextDecoder().decode(header.subarray(0, boundary)))
              if (isRecord(metadata)) {
                if (isString(metadata.key)) entry.key = metadata.key
                if (isString(metadata.type)) entry.contentType = metadata.type
              }
              entry.size = body.size - boundary - 1
            }
            catch {
              // A damaged cache entry still lists with its stored size.
            }
          }
          entries.push(entry)
        }
      }
      return entries
    }),
    async planVariant(pathname, variant) {
      if (!images) return undefined
      const object = await driver.head(pathname)
      const type = object?.contentType?.split(";")[0]!.trim().toLowerCase()
      if (!object || !type || !transformableTypes.has(type)) return undefined
      const transformer = await selectImageTransformer(images)
      if (!transformer) return undefined
      const record = await load(pathname)
      if (!record?.width || !record.height) return undefined
      const crop = variant.crop ? record.crops?.[variant.crop] : undefined
      const aspect = crop ? parseAspectRatio(crop.aspect) : undefined
      const replacement = crop?.replacement?.width && crop.replacement.height ? crop.replacement : undefined
      const source = replacement ?? { height: record.height, pathname, width: record.width }
      const geometry = resolveImageGeometry({
        ...(aspect ? { aspect } : {}),
        // A replacement is already art-directed, so it crops from its center.
        ...(!replacement && (crop?.focal ?? record.focal) ? { focal: crop?.focal ?? record.focal } : {}),
        sizes: images.sizes,
        source: { height: source.height!, width: source.width! },
        variant: aspect ? { ...variant, fit: "cover" } : variant,
      })
      const format = variant.format ?? "webp"
      const quality = format === "png" ? undefined : variant.quality ?? images.quality
      const operation = { ...geometry, format, ...(quality === undefined ? {} : { quality }) }
      const region = geometry.extract ? `region=${geometry.extract.left},${geometry.extract.top},${geometry.extract.width}x${geometry.extract.height};` : ""
      const origin = crop ? `crop:${variant.crop}${replacement ? `:${replacement.hash.slice(0, 12)}` : ""}` : "original"
      const key = `image:v1;src=${origin};${region}out=${geometry.width}x${geometry.height};fmt=${format};${quality === undefined ? "" : `q=${quality};`}engine=${transformer.name}`
      return {
        source: source.pathname,
        transform: { key, run: original => transformer.transform(original, operation) },
      }
    },
  }
  return media
}

export { isReservedPathname as isReservedMediaPathname }
