import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

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
  if (typeof body === "string") {
    return Buffer.from(body)
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body)
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }

  const arrayBuffer = await new Response(body as any).arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function collectFiles(dir: string, files: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) {
    return files
  }

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(absolute, files)
      continue
    }

    if (!entry.name.endsWith(".meta.json")) {
      files.push(absolute)
    }
  }

  return files
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

      if (listOptions.folded) {
        const folders = new Set<string>()
        const blobs: BlobObject[] = []
        const limit = listOptions.limit ?? 1000
        const cursor = Number.parseInt(Buffer.from(listOptions.cursor || "", "base64url").toString("utf8") || "0")
        const start = Number.isFinite(cursor) ? cursor : 0
        const values = allFiles.slice(start)
        let consumed = start

        for (const pathname of values) {
          consumed += 1
          const remainder = prefix ? pathname.slice(prefix.length).replace(/^\/+/, "") : pathname
          const firstSlash = remainder.indexOf("/")
          if (firstSlash !== -1) {
            const folder = remainder.slice(0, firstSlash + 1)
            folders.add(prefix ? `${prefix.replace(/\/?$/, "/")}${folder}` : folder)
            continue
          }

          const meta = await this.head(pathname)
          if (meta) {
            blobs.push(meta)
          }
          if (blobs.length >= limit) {
            break
          }
        }

        return {
          blobs,
          cursor: consumed < allFiles.length ? Buffer.from(String(consumed)).toString("base64url") : undefined,
          folders: [...folders].sort((left, right) => left.localeCompare(right)),
          hasMore: consumed < allFiles.length,
        }
      }

      const limit = listOptions.limit ?? 1000
      const cursor = Number.parseInt(Buffer.from(listOptions.cursor || "", "base64url").toString("utf8") || "0")
      const start = Number.isFinite(cursor) ? cursor : 0
      const slice = allFiles.slice(start, start + limit)
      const blobs = (await Promise.all(slice.map(pathname => this.head(pathname)))).filter(Boolean) as BlobObject[]
      const next = start + slice.length

      return {
        blobs,
        cursor: next < allFiles.length ? Buffer.from(String(next)).toString("base64url") : undefined,
        hasMore: next < allFiles.length,
      }
    },
    async put(pathname, body, putOptions: BlobPutOptions = {}) {
      const file = resolveSafePath(base, pathname)
      await mkdir(dirname(file), { recursive: true })
      const buffer = await toBuffer(body)
      const httpEtag = `"${createHash("sha1").update(buffer).digest("hex")}"`
      await writeFile(file, buffer)
      await writeMetadata(file, {
        contentType: putOptions.contentType,
        customMetadata: putOptions.customMetadata,
        httpEtag,
        size: buffer.byteLength,
        uploadedAt: new Date().toISOString(),
      })
      return createObject(normalizePathname(pathname), {
        contentType: putOptions.contentType,
        customMetadata: putOptions.customMetadata,
        httpEtag,
        size: buffer.byteLength,
        uploadedAt: new Date().toISOString(),
      }, buffer.byteLength)
    },
  }
}
