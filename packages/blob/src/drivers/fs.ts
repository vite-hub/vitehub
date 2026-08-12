import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedFsBlobStoreConfig } from "../types.ts"

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
    throw new Error(`Blob pathname escapes the configured base: ${pathname}`)
  }
  return path
}

function resolveMetaPath(root: string, pathname: string) {
  return resolve(root, ".vitehub", "blob-meta", `${encodeMetaKey(pathname)}.json`)
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
    const remainder = entry.path.slice(prefix.length).replace(/^\/+/, "")
    const firstSlash = remainder.indexOf("/")
    if (firstSlash !== -1) {
      folders.add(`${prefix.replace(/\/?$/, "/")}${remainder.slice(0, firstSlash + 1)}`)
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

  return {
    name: "fs",
    options,
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
}
