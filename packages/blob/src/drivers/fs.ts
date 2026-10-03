import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobListOptions, BlobListResult, BlobMultipartOptions, BlobObject, BlobPutBody, BlobPutOptions, ResolvedFsBlobStoreConfig } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"

interface FsMultipartState {
  contentType?: string
  customMetadata?: Record<string, string>
  pathname: string
}

const uploadIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

// Parts wait under the reserved `.vitehub` directory, which list() and user pathnames never reach.
function resolveMultipartDir(root: string, uploadId: string) {
  if (!uploadIdPattern.test(uploadId)) {
    throw blobErrorDiagnostics.BLOB_R0032({ message: `Unknown multipart upload: ${uploadId}` })
  }
  return resolve(root, ".vitehub", "multipart", uploadId)
}

function partEtag(bytes: Uint8Array) {
  return `"${createHash("sha1").update(bytes).digest("hex")}"`
}

interface FsBlobMetadata {
  contentType?: string
  customMetadata?: Record<string, string>
}

interface FsBlobEntry {
  meta: FsBlobMetadata
  path: string
  size: number
  uploadedAt: Date
}

function encodeCursor(value: number) {
  return Buffer.from(String(value)).toString("base64url")
}

function decodeCursor(cursor: string | undefined) {
  const parsed = Number.parseInt(Buffer.from(cursor || "", "base64url").toString("utf8") || "0")
  return Number.isFinite(parsed) ? parsed : 0
}

function encodeMetaKey(pathname: string) {
  return Buffer.from(pathname).toString("base64url")
}

function isInside(root: string, path: string) {
  const resolvedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return path === root || path.startsWith(resolvedRoot)
}

function resolveRoot(options: ResolvedFsBlobStoreConfig) {
  return resolve(options.base)
}

function resolveBlobPath(root: string, pathname: string) {
  const path = resolve(root, pathname)
  if (!isInside(root, path)) {
    throw blobErrorDiagnostics.BLOB_R0005({ message: `Blob pathname escapes the configured base: ${pathname}` })
  }
  const relativePath = relative(root, path)
  const normalizedRelativePath = relativePath.toLowerCase()
  if (normalizedRelativePath === ".vitehub" || normalizedRelativePath.startsWith(`.vitehub${sep}`)) {
    throw blobErrorDiagnostics.BLOB_R0005({ message: `Blob pathname uses a reserved internal path: ${pathname}` })
  }
  return path
}

function resolveMetaPath(root: string, pathname: string) {
  const normalized = relative(root, resolveBlobPath(root, pathname)).split(sep).join("/")
  return resolve(root, ".vitehub", "blob-meta", `${encodeMetaKey(normalized)}.json`)
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function isDirectoryError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR"
}

async function bodyToBytes(body: BlobPutBody) {
  return new Uint8Array(await new Response(body as any).arrayBuffer())
}

async function readMetadata(root: string, pathname: string): Promise<FsBlobMetadata> {
  try {
    return JSON.parse(await readFile(resolveMetaPath(root, pathname), "utf8")) as FsBlobMetadata
  }
  catch (error) {
    if (isNotFound(error)) return {}
    throw error
  }
}

async function writeMetadata(root: string, pathname: string, meta: FsBlobMetadata) {
  const path = resolveMetaPath(root, pathname)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(meta), "utf8")
}

async function removeMetadata(root: string, pathname: string) {
  await rm(resolveMetaPath(root, pathname), { force: true })
}

function toBlobObject(entry: FsBlobEntry): BlobObject {
  const httpEtag = createHash("sha1")
    .update(`${entry.path}:${entry.size}:${entry.uploadedAt.getTime()}`)
    .digest("hex")

  return {
    contentType: entry.meta.contentType,
    customMetadata: entry.meta.customMetadata || {},
    httpEtag: `"${httpEtag}"`,
    httpMetadata: entry.meta.contentType ? { contentType: entry.meta.contentType } : {},
    pathname: entry.path,
    size: entry.size,
    uploadedAt: entry.uploadedAt,
  }
}

async function readEntry(root: string, pathname: string): Promise<FsBlobEntry | null> {
  try {
    const stats = await stat(resolveBlobPath(root, pathname))
    if (!stats.isFile()) return null
    return {
      meta: await readMetadata(root, pathname),
      path: pathname,
      size: stats.size,
      uploadedAt: stats.mtime,
    }
  }
  catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(dir, entry.name)
    const pathname = relative(root, path).split(sep).join("/")
    if (pathname === ".vitehub" || pathname.startsWith(".vitehub/")) return []
    if (entry.isDirectory()) return await walkFiles(root, path)
    return entry.isFile() ? [pathname] : []
  }))
  return files.flat().sort((left, right) => left.localeCompare(right))
}

async function listEntries(root: string, prefix?: string) {
  const files = await walkFiles(root)
  const filtered = prefix ? files.filter(path => path.startsWith(prefix)) : files
  const entries = await Promise.all(filtered.map(path => readEntry(root, path)))
  return entries.filter((entry): entry is FsBlobEntry => Boolean(entry))
}

function foldedList(entries: FsBlobEntry[], options: BlobListOptions): BlobListResult {
  const prefix = options.prefix || ""
  const start = decodeCursor(options.cursor)
  const limit = options.limit ?? 1000
  const folders = new Set<string>()
  const blobs: BlobObject[] = []
  let consumed = start

  for (const entry of entries.slice(start)) {
    consumed += 1
    const remainder = entry.path.slice(prefix.length)
    const firstSlash = remainder.indexOf("/")
    if (firstSlash !== -1) {
      folders.add(entry.path.slice(0, prefix.length + firstSlash + 1))
      continue
    }

    blobs.push(toBlobObject(entry))
    if (blobs.length >= limit) break
  }

  return {
    blobs,
    cursor: consumed < entries.length ? encodeCursor(consumed) : undefined,
    folders: [...folders].sort((left, right) => left.localeCompare(right)),
    hasMore: consumed < entries.length,
  }
}

export function createDriver(options: ResolvedFsBlobStoreConfig): BlobDriverAdapter<ResolvedFsBlobStoreConfig> {
  const root = resolveRoot(options)

  function multipartUpload(uploadId: string, state: FsMultipartState): BlobDriverMultipartUpload {
    const dir = resolveMultipartDir(root, uploadId)
    return {
      pathname: state.pathname,
      uploadId,
      async abort() {
        await rm(dir, { force: true, recursive: true })
      },
      async complete(parts) {
        const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber)
        const chunks = await Promise.all(ordered.map(async (part) => {
          const bytes = await readFile(resolve(dir, String(part.partNumber))).catch((error: unknown) => {
            if (isNotFound(error)) throw blobErrorDiagnostics.BLOB_R0032({ message: `Multipart upload ${uploadId} has no part ${part.partNumber}.` })
            throw error
          })
          if (partEtag(bytes) !== part.etag) {
            throw blobErrorDiagnostics.BLOB_R0032({ message: `Part ${part.partNumber} of multipart upload ${uploadId} does not match its etag.` })
          }
          return bytes
        }))
        const object = await driver.put(state.pathname, new Blob(chunks), {
          contentType: state.contentType,
          customMetadata: state.customMetadata,
        })
        await rm(dir, { force: true, recursive: true })
        return object
      },
      async uploadPart(partNumber, body) {
        const bytes = await bodyToBytes(body)
        await writeFile(resolve(dir, String(partNumber)), bytes)
        return { etag: partEtag(bytes), partNumber }
      },
    }
  }

  const driver: BlobDriverAdapter<ResolvedFsBlobStoreConfig> = {
    name: "fs",
    options,
    async createMultipartUpload(pathname: string, multipartOptions: BlobMultipartOptions) {
      resolveBlobPath(root, pathname)
      const uploadId = randomUUID()
      const state: FsMultipartState = {
        contentType: multipartOptions.contentType,
        customMetadata: multipartOptions.customMetadata,
        pathname,
      }
      const dir = resolveMultipartDir(root, uploadId)
      await mkdir(dir, { recursive: true })
      await writeFile(resolve(dir, "state.json"), JSON.stringify(state), "utf8")
      return multipartUpload(uploadId, state)
    },
    async resumeMultipartUpload(pathname: string, uploadId: string) {
      const dir = resolveMultipartDir(root, uploadId)
      let state: FsMultipartState
      try {
        // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization,typescript/strict/require-safety-comment-for-type-assertion -- The state file is written by this driver and its pathname and upload ID are checked below.
        state = JSON.parse(await readFile(resolve(dir, "state.json"), "utf8")) as FsMultipartState
      }
      catch (error) {
        if (isNotFound(error)) throw blobErrorDiagnostics.BLOB_R0032({ message: `Unknown multipart upload: ${uploadId}` })
        throw error
      }
      if (state.pathname !== pathname) {
        throw blobErrorDiagnostics.BLOB_R0032({ message: `Multipart upload ${uploadId} belongs to another pathname.` })
      }
      return multipartUpload(uploadId, state)
    },
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(async pathname => {
        await rm(resolveBlobPath(root, pathname), { force: true })
        await removeMetadata(root, pathname)
      }))
    },
    async get(pathname) {
      const bytes = await this.getArrayBuffer(pathname)
      if (!bytes) return null
      const meta = await readMetadata(root, pathname)
      return new Blob([bytes], { type: meta.contentType || "" })
    },
    async getArrayBuffer(pathname) {
      try {
        const bytes = await readFile(resolveBlobPath(root, pathname))
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async head(pathname) {
      const entry = await readEntry(root, pathname)
      return entry ? toBlobObject(entry) : null
    },
    async list(options: BlobListOptions = {}): Promise<BlobListResult> {
      try {
        const entries = await listEntries(root, options.prefix)
        if (options.folded) {
          return foldedList(entries, options)
        }

        const start = decodeCursor(options.cursor)
        const limit = options.limit ?? 1000
        const page = entries.slice(start, start + limit)
        const consumed = start + page.length
        return {
          blobs: page.map(toBlobObject),
          cursor: consumed < entries.length ? encodeCursor(consumed) : undefined,
          hasMore: consumed < entries.length,
        }
      }
      catch (error) {
        if (isNotFound(error)) {
          return { blobs: [], hasMore: false }
        }
        if (isDirectoryError(error)) {
          throw Object.assign(error as object, { code: "ENOTDIR" })
        }
        throw error
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const path = resolveBlobPath(root, pathname)
      const bytes = await bodyToBytes(body)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
      await writeMetadata(root, pathname, {
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        customMetadata: putOptions.customMetadata,
      })
      const entry = await readEntry(root, pathname)
      return toBlobObject(entry!)
    },
  }
  return driver
}
