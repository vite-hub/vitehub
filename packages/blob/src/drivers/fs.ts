import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "pathe"

import { toArray } from "@vitehub/internal/arrays"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedFsBlobStoreConfig } from "../types.ts"

type FsBlobMetadata = {
  contentType?: string
  customMetadata?: Record<string, string>
  httpEtag?: string
  size?: number
  uploadedAt?: string
}

function normalizePathname(pathname: string) {
  return pathname.replace(/^\/+/, "").replace(/\\/g, "/")
}

function resolveSafePath(base: string, pathname: string) {
  const resolved = resolve(base, ...normalizePathname(pathname).split("/").filter(Boolean))
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(`Blob pathname escapes the configured base: ${pathname}`)
  }
  return resolved
}

function metaFile(file: string) {
  return `${file}.meta.json`
}

function createObject(pathname: string, metadata: FsBlobMetadata, size: number): BlobObject {
  return {
    contentType: metadata.contentType,
    customMetadata: metadata.customMetadata || {},
    httpEtag: metadata.httpEtag,
    httpMetadata: metadata.contentType ? { contentType: metadata.contentType } : {},
    pathname,
    size: metadata.size ?? size,
    uploadedAt: metadata.uploadedAt ? new Date(metadata.uploadedAt) : new Date(),
  }
}

async function readMetadata(file: string): Promise<FsBlobMetadata> {
  try {
    return JSON.parse(await readFile(metaFile(file), "utf8")) as FsBlobMetadata
  }
  catch {
    return {}
  }
}

async function writeMetadata(file: string, metadata: FsBlobMetadata) {
  await writeFile(metaFile(file), `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
}

async function toBuffer(body: BlobPutBody): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return Buffer.from(await new Response(body as Blob | ReadableStream<Uint8Array>).arrayBuffer())
}

async function collectFiles(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { recursive: true, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && !entry.name.endsWith(".meta.json"))
      .map(entry => join(entry.parentPath ?? base, entry.name))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }

    throw error
  }
}

function encodeCursor(value: number) {
  return Buffer.from(String(value)).toString("base64url")
}

function decodeCursor(cursor: string | undefined) {
  const parsed = Number.parseInt(Buffer.from(cursor || "", "base64url").toString("utf8") || "0")
  return Number.isFinite(parsed) ? parsed : 0
}

export function createDriver(options: ResolvedFsBlobStoreConfig): BlobDriverAdapter<ResolvedFsBlobStoreConfig> {
  const base = resolve(options.base)

  return {
    name: "fs",
    options,
    async delete(pathnames) {
      await Promise.all(toArray(pathnames).flatMap(pathname => {
        const file = resolveSafePath(base, pathname)
        return [
          rm(file, { force: true }),
          rm(metaFile(file), { force: true }),
        ]
      }))
    },
    async get(pathname) {
      const file = resolveSafePath(base, pathname)
      try {
        const buffer = await readFile(file)
        const metadata = await readMetadata(file)
        return new Blob([buffer], { type: metadata.contentType || "application/octet-stream" })
      }
      catch {
        return null
      }
    },
    async getArrayBuffer(pathname) {
      const file = resolveSafePath(base, pathname)
      try {
        const buffer = await readFile(file)
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
      catch {
        return null
      }
    },
    async head(pathname) {
      const file = resolveSafePath(base, pathname)
      try {
        const info = await stat(file)
        const metadata = await readMetadata(file)
        return createObject(normalizePathname(pathname), metadata, info.size)
      }
      catch {
        return null
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const prefix = normalizePathname(listOptions.prefix || "")
      const allFiles = (await collectFiles(base))
        .map(file => normalizePathname(relative(base, file)))
        .filter(pathname => !prefix || pathname.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right))

      const limit = listOptions.limit ?? 1000
      const start = decodeCursor(listOptions.cursor)

      if (listOptions.folded) {
        const folders = new Set<string>()
        const blobs: BlobObject[] = []
        let consumed = start

        for (const pathname of allFiles.slice(start)) {
          consumed += 1
          const remainder = prefix ? pathname.slice(prefix.length).replace(/^\/+/, "") : pathname
          const firstSlash = remainder.indexOf("/")
          if (firstSlash !== -1) {
            const folder = remainder.slice(0, firstSlash + 1)
            folders.add(prefix ? `${prefix.replace(/\/?$/, "/")}${folder}` : folder)
            continue
          }

          const meta = await this.head(pathname)
          if (meta) blobs.push(meta)
          if (blobs.length >= limit) break
        }

        return {
          blobs,
          cursor: consumed < allFiles.length ? encodeCursor(consumed) : undefined,
          folders: [...folders].sort((left, right) => left.localeCompare(right)),
          hasMore: consumed < allFiles.length,
        }
      }

      const slice = allFiles.slice(start, start + limit)
      const blobs = (await Promise.all(slice.map(pathname => this.head(pathname)))).filter(Boolean) as BlobObject[]
      const next = start + slice.length

      return {
        blobs,
        cursor: next < allFiles.length ? encodeCursor(next) : undefined,
        hasMore: next < allFiles.length,
      }
    },
    async put(pathname, body, putOptions: BlobPutOptions = {}) {
      const file = resolveSafePath(base, pathname)
      await mkdir(dirname(file), { recursive: true })
      const buffer = await toBuffer(body)
      const httpEtag = `"${createHash("sha1").update(buffer).digest("hex")}"`
      const metadata: FsBlobMetadata = {
        contentType: putOptions.contentType,
        customMetadata: putOptions.customMetadata,
        httpEtag,
        size: buffer.byteLength,
        uploadedAt: new Date().toISOString(),
      }
      await writeFile(file, buffer)
      await writeMetadata(file, metadata)
      return createObject(normalizePathname(pathname), metadata, buffer.byteLength)
    },
  }
}
