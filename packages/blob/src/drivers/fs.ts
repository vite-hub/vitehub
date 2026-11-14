import type { BigIntStats, Dirent } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import { number, object, optional, parse, record, safeParse, string } from "valibot"

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobListOptions, BlobListResult, BlobMultipartOptions, BlobObject, BlobPutBody, BlobPutOptions, ResolvedFsBlobStoreConfig } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import isBlob from "../internal/is-blob.ts"
import { signFsRequest } from "../internal/fs-sign.ts"

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

const fsBlobMetadataSchema = object({
  contentType: optional(string()),
  customMetadata: optional(record(string(), string())),
})

// Generation sidecars also record which bytes they describe, so metadata can
// follow a payload whose inode changed when the data root was copied.
const fsBlobGenerationSchema = object({
  ...fsBlobMetadataSchema.entries,
  contentHash: optional(string()),
  mtimeNs: optional(string()),
  size: optional(number()),
})

const fsBlobHashSchema = object({ contentHash: string(), fileVersion: string() })

interface FsBlobEntry {
  contentHash: string
  meta: FsBlobMetadata
  path: string
  size: number
  uploadedAt: Date
}

// The cursor holds the last listed key. Keys sort by UTF-16 code unit, so a
// key added or removed between pages cannot shift the next page.
const cursorPrefix = "after:"

function encodeCursor(after: string) {
  return Buffer.from(`${cursorPrefix}${after}`).toString("base64url")
}

function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return ""
  // Internal invariant: blobResult() returns a bad cursor as the cause of BLOB_OPERATION_FAILED. A code would change the TypeError class.
  if (!/^[A-Za-z0-9_-]*$/.test(cursor) || cursor.length % 4 === 1) throw new TypeError("Invalid Blob cursor.")
  const decodedBytes = Buffer.from(cursor, "base64url")
  const decoded = decodedBytes.toString("utf8")
  // Internal invariant: blobResult() returns a bad cursor as the cause of BLOB_OPERATION_FAILED. A code would change the TypeError class.
  if (decodedBytes.toString("base64url") !== cursor || !Buffer.from(decoded).equals(decodedBytes) || !decoded.startsWith(cursorPrefix)) throw new TypeError("Invalid Blob cursor.")
  return decoded.slice(cursorPrefix.length)
}

function compareKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function encodeMetaKey(pathname: string) {
  const encoded = Buffer.from(pathname).toString("base64url")
  // Reserve five bytes for .json within the usual 255-byte filename limit.
  // The dot keeps hashed keys distinct from legacy Base64url keys.
  return encoded.length <= 250 ? encoded : `sha256.${createHash("sha256").update(pathname).digest("hex")}`
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

async function assertNoSymlinkPath(root: string, path: string) {
  let current = root
  const relativePath = relative(root, path)
  for (const component of ["", ...relativePath.split(sep).filter(Boolean)]) {
    current = resolve(current, component)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        throw blobErrorDiagnostics.BLOB_R0005({ message: `Blob pathname crosses a symbolic link: ${path}` })
      }
      // A multiply-linked regular file may have another name outside root. Reject it
      // before writes so replacing a blob cannot mutate an external inode.
      if (stats.isFile() && stats.nlink > 1) {
        throw blobErrorDiagnostics.BLOB_R0005({ message: `Blob pathname crosses a hard link: ${path}` })
      }
    }
    catch (error) {
      if (isNotFound(error)) return
      throw error
    }
  }
}

function resolveMetaPath(root: string, pathname: string, directory = "blob-meta") {
  const normalized = relative(root, resolveBlobPath(root, pathname)).split(sep).join("/")
  return resolve(root, ".vitehub", directory, `${encodeMetaKey(normalized)}.json`)
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

function fileVersion(stats: BigIntStats) {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

function generationMetaPrefix(root: string, pathname: string) {
  const normalized = relative(root, resolveBlobPath(root, pathname)).split(sep).join("/")
  // Keep sidecar filenames bounded even for deeply nested Blob keys.
  return `generation-${createHash("sha256").update(normalized).digest("hex")}-`
}

function generationMetaPath(root: string, pathname: string, stats: BigIntStats) {
  // Inode and birth time survive rename; ctime does not. Deletion pins the
  // inode until sidecar cleanup finishes, even when birth time is unavailable.
  return resolve(root, ".vitehub", "blob-meta", `${generationMetaPrefix(root, pathname)}${stats.dev}-${stats.ino}-${stats.birthtimeNs}.json`)
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function sha256File(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

function metadataKey(metadata: FsBlobMetadata) {
  const custom = Object.entries(metadata.customMetadata || {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return JSON.stringify([metadata.contentType ?? null, custom])
}

function singleMetadata(candidates: FsBlobMetadata[]): FsBlobMetadata | undefined {
  const [first] = candidates
  if (!first || candidates.some(candidate => metadataKey(candidate) !== metadataKey(first))) return
  return { contentType: first.contentType, customMetadata: first.customMetadata }
}

// One read of the sidecar directory, grouped by pathname prefix and shared
// by every key in one operation. A per-key scan makes list() quadratic after
// a copy, because every key then misses its inode-keyed sidecar.
type SidecarIndex = () => Promise<Map<string, string[]>>

function sidecarIndex(root: string): SidecarIndex {
  let index: Promise<Map<string, string[]>> | undefined
  return () => index ??= (async () => {
    const directory = resolve(root, ".vitehub", "blob-meta")
    const groups = new Map<string, string[]>()
    let names: string[]
    try {
      await assertNoSymlinkPath(root, directory)
      names = await readdir(directory)
    }
    catch (error) {
      if (isNotFound(error) || isDirectoryError(error)) return groups
      throw error
    }
    for (const name of names) {
      const prefix = /^generation-[\da-f]{64}-/.exec(name)?.[0]
      if (!prefix || !name.endsWith(".json")) continue
      groups.set(prefix, [...groups.get(prefix) ?? [], name])
    }
    return groups
  })()
}

// Copying, restoring, or moving the data root gives each payload a new inode,
// so its generation sidecar name no longer matches. Accept another generation
// of the same pathname only when it recorded these exact bytes. When several
// generations recorded these bytes with different metadata, the modification
// time must also match, or no metadata is applied.
async function readCopiedMetadata(root: string, pathname: string, stats: BigIntStats, contentHash: () => Promise<string>, sidecars: SidecarIndex): Promise<FsBlobMetadata | undefined> {
  const directory = resolve(root, ".vitehub", "blob-meta")
  const names = (await sidecars()).get(generationMetaPrefix(root, pathname)) ?? []
  const candidates = (await Promise.all(names.map(async (name) => {
    const path = resolve(directory, name)
    await assertNoSymlinkPath(root, path)
    try {
      const result = safeParse(fsBlobGenerationSchema, JSON.parse(await readFile(path, "utf8")))
      return result.success ? result.output : undefined
    }
    catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return
      throw error
    }
  }))).filter(candidate => candidate?.contentHash !== undefined && candidate.size === Number(stats.size))
  // Old sidecars without a content hash cannot prove which bytes they describe.
  if (candidates.length === 0) return
  const hash = await contentHash()
  const mtimeNs = String(stats.mtimeNs)
  const matches = candidates.flatMap(candidate => candidate?.contentHash === hash ? [candidate] : [])
  const metadata = singleMetadata(matches) ?? singleMetadata(matches.filter(candidate => candidate.mtimeNs === mtimeNs))
  if (!metadata) return
  // Skip the re-key when the payload already changed. A write can still land
  // before the sidecar is published, so readers also check its recorded hash.
  const path = resolveBlobPath(root, pathname)
  if (fileVersion(stats) === fileVersion(await stat(path, { bigint: true }))) {
    await writeAtomic(root, generationMetaPath(root, pathname, stats), JSON.stringify({ ...metadata, contentHash: hash, mtimeNs, size: Number(stats.size) })).catch((error) => {
      console.error("[vitehub/blob] Filesystem metadata re-key failed", error)
    })
  }
  return metadata
}

async function readMetadata(root: string, pathname: string, stats: BigIntStats, contentHash: () => Promise<string>, sidecars = sidecarIndex(root)): Promise<FsBlobMetadata> {
  const generation = generationMetaPath(root, pathname, stats)
  await assertNoSymlinkPath(root, generation)
  try {
    const sidecar: unknown = JSON.parse(await readFile(generation, "utf8"))
    const recorded = parse(fsBlobGenerationSchema, sidecar)
    // An in-place write keeps the inode, so a recorded hash must still match.
    if (recorded.contentHash === undefined || (recorded.size === Number(stats.size) && recorded.contentHash === await contentHash())) {
      return parse(fsBlobMetadataSchema, sidecar)
    }
  }
  catch (error) {
    if (!isNotFound(error)) throw error
  }
  const copied = await readCopiedMetadata(root, pathname, stats, contentHash, sidecars)
  if (copied) return copied
  // Existing plain files and legacy sidecars remain readable.
  try {
    const path = resolveMetaPath(root, pathname)
    await assertNoSymlinkPath(root, path)
    const metadata: unknown = JSON.parse(await readFile(path, "utf8"))
    return parse(fsBlobMetadataSchema, metadata)
  }
  catch (error) {
    if (isNotFound(error)) return {}
    throw error
  }
}

/** Writes `content` to a new file. A function writes the new file itself, for example with `copyFile()`. */
type AtomicContent = Uint8Array | string | ((temporary: string) => Promise<void>)

async function writeAtomic(root: string, path: string, content: AtomicContent, beforePublish?: (temporary: string) => Promise<void>) {
  // Keep incomplete bytes outside user listings, then publish one complete file.
  const temporary = resolve(root, ".vitehub", "blob-writes", randomUUID())
  await assertNoSymlinkPath(root, temporary)
  await mkdir(dirname(temporary), { recursive: true })
  try {
    if (typeof content === "function") await content(temporary)
    else await writeFile(temporary, content, { flag: "wx" })
    await beforePublish?.(temporary)
    await assertNoSymlinkPath(root, path)
    await rename(temporary, path)
  }
  finally {
    await rm(temporary, { force: true })
  }
}

async function removeMetadata(root: string, pathname: string, generation?: BigIntStats) {
  // Only reclaim a generation observed before unlinking the payload. A prefix
  // sweep can erase a concurrent writer's prepared (or newly live) metadata.
  if (generation) {
    const path = generationMetaPath(root, pathname, generation)
    await assertNoSymlinkPath(root, path)
    await rm(path, { force: true })
  }
  for (const directory of ["blob-meta", "blob-hashes"]) {
    const path = resolveMetaPath(root, pathname, directory)
    await assertNoSymlinkPath(root, path)
    await rm(path, { force: true })
  }
}

async function readHash(root: string, pathname: string) {
  const path = resolveMetaPath(root, pathname, "blob-hashes")
  await assertNoSymlinkPath(root, path)
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    const result = safeParse(fsBlobHashSchema, value)
    return result.success ? result.output : undefined
  }
  catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return
    throw error
  }
}

async function writeHash(root: string, pathname: string, hash: { contentHash: string, fileVersion: string }) {
  const path = resolveMetaPath(root, pathname, "blob-hashes")
  await assertNoSymlinkPath(root, path)
  await mkdir(dirname(path), { recursive: true })
  await writeAtomic(root, path, JSON.stringify(hash))
}

function toBlobObject(entry: FsBlobEntry): BlobObject {
  return {
    contentType: entry.meta.contentType,
    customMetadata: entry.meta.customMetadata || {},
    httpEtag: `"${entry.contentHash}"`,
    httpMetadata: entry.meta.contentType ? { contentType: entry.meta.contentType } : {},
    pathname: entry.path,
    size: entry.size,
    uploadedAt: entry.uploadedAt,
  }
}

async function readEntry(root: string, pathname: string, sidecars = sidecarIndex(root)): Promise<FsBlobEntry | null> {
  try {
    const path = resolveBlobPath(root, pathname)
    for (let attempt = 0; attempt < 3; attempt++) {
      // Legacy content files may block descendant paths, but internal sidecar errors must propagate.
      const stats = await (async () => {
        try {
          await assertNoSymlinkPath(root, path)
          return await stat(path, { bigint: true })
        }
        catch (error) {
          if (isDirectoryError(error)) return null
          throw error
        }
      })()
      if (!stats?.isFile()) return null
      const version = fileVersion(stats)
      const cached = await readHash(root, pathname)
      let contentHash = cached?.fileVersion === version ? cached.contentHash : undefined
      if (!contentHash) {
        contentHash = sha256(await readFile(path))
        const after = await stat(path, { bigint: true })
        if (version !== fileVersion(after)) continue
        await writeHash(root, pathname, { contentHash, fileVersion: version }).catch((error) => {
          console.error("[vitehub/blob] Filesystem hash cache write failed", error)
        })
      }
      const hash = contentHash
      const meta = await readMetadata(root, pathname, stats, async () => hash, sidecars)
      if (version !== fileVersion(await stat(path, { bigint: true }))) continue
      return {
        contentHash,
        meta,
        path: pathname,
        size: Number(stats.size),
        uploadedAt: stats.mtime,
      }
    }
    // Internal invariant: blobResult() returns this as the cause of BLOB_OPERATION_FAILED.
    throw new Error("Blob changed while reading its filesystem metadata.")
  }
  catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function readDirectory(root: string, dir: string): Promise<Dirent[]> {
  try {
    await assertNoSymlinkPath(root, dir)
    return await readdir(dir, { withFileTypes: true })
  }
  catch (error) {
    // A child directory can disappear or become a file after its parent was read.
    if (dir !== root && (isNotFound(error) || isDirectoryError(error))) {
      // Only recover if the store root is still safe and readable as a directory.
      await assertNoSymlinkPath(root, root)
      await readdir(root)
      return []
    }
    throw error
  }
}

interface ListScope {
  after: string
  folded: boolean
  prefix: string
}

interface ListItem {
  folder: boolean
  key: string
}

// Directory keys end with "/", so sorting each directory by key gives the
// global key order. Only directories on the prefix path, after the cursor,
// and before the page ends are read.
async function* walkKeys(root: string, scope: ListScope, dir = root, dirKey = ""): AsyncGenerator<ListItem> {
  const children = (await readDirectory(root, dir)).flatMap((entry) => {
    if (entry.isDirectory()) return [{ directory: true, key: `${dirKey}${entry.name}/`, name: entry.name }]
    return entry.isFile() ? [{ directory: false, key: `${dirKey}${entry.name}`, name: entry.name }] : []
  }).sort((left, right) => compareKeys(left.key, right.key))
  for (const child of children) {
    if (child.key === ".vitehub/") continue
    if (!child.directory) {
      if (child.key.startsWith(scope.prefix) && child.key > scope.after) yield { folder: false, key: child.key }
      continue
    }
    const belowPrefix = child.key.length > scope.prefix.length && child.key.startsWith(scope.prefix)
    if (!belowPrefix && !scope.prefix.startsWith(child.key)) continue
    // Every key in this directory sorts before the cursor.
    if (child.key < scope.after && !scope.after.startsWith(child.key)) continue
    const path = resolve(dir, child.name)
    if (scope.folded && belowPrefix) {
      if (await containsFile(root, path)) yield { folder: true, key: child.key }
      continue
    }
    yield* walkKeys(root, scope, path, child.key)
  }
}

async function containsFile(root: string, dir: string): Promise<boolean> {
  const entries = await readDirectory(root, dir)
  if (entries.some(entry => entry.isFile())) return true
  for (const entry of entries) {
    if (entry.isDirectory() && await containsFile(root, resolve(dir, entry.name))) return true
  }
  return false
}

async function listEntries(root: string, paths: string[]) {
  const sidecars = sidecarIndex(root)
  const entries = await Promise.all(paths.map(path => readEntry(root, path, sidecars)))
  return entries.filter((entry): entry is FsBlobEntry => Boolean(entry))
}

async function listKeys(root: string, options: BlobListOptions, after: string): Promise<BlobListResult> {
  const limit = options.limit ?? 1000
  const folded = Boolean(options.folded)
  const folders: string[] = []
  const selected: string[] = []
  const items = walkKeys(root, { after, folded, prefix: options.prefix || "" })
  let hasMore = false

  for await (const item of items) {
    // A zero limit is an empty page. A folded listing still reports every folder after the cursor.
    if (selected.length >= limit && (limit > 0 || !folded)) {
      hasMore = true
      break
    }
    if (limit <= 0) hasMore = true
    if (item.folder) folders.push(item.key)
    else if (limit > 0) selected.push(item.key)
  }

  const entries = await listEntries(root, selected)
  // A selected file removed during metadata reads still moves the cursor past its key.
  const last = limit > 0 ? selected.at(-1) ?? after : after
  return {
    blobs: entries.map(toBlobObject),
    cursor: hasMore ? encodeCursor(last) : undefined,
    ...(folded ? { folders } : {}),
    hasMore,
  }
}

export function createDriver(options: ResolvedFsBlobStoreConfig): BlobDriverAdapter<ResolvedFsBlobStoreConfig> {
  const root = resolveRoot(options)

  // Writes the payload to a temporary file, prepares its metadata, then publishes it with one rename.
  // `write` creates the temporary file and returns the SHA-256 of its bytes.
  async function publish(pathname: string, write: (temporary: string) => Promise<string>, metadata: FsBlobMetadata) {
    const path = resolveBlobPath(root, pathname)
    await assertNoSymlinkPath(root, path)
    await assertNoSymlinkPath(root, resolveMetaPath(root, pathname))
    await mkdir(dirname(path), { recursive: true })
    let contentHash = ""
    let written: BigIntStats | undefined
    await writeAtomic(root, path, async (temporary) => {
      contentHash = await write(temporary)
    }, async (temporary) => {
      const stats = written = await stat(temporary, { bigint: true })
      const metadataPath = generationMetaPath(root, pathname, stats)
      await assertNoSymlinkPath(root, metadataPath)
      await mkdir(dirname(metadataPath), { recursive: true })
      // Prepare immutable metadata before the only visible publication step:
      // renaming the payload. Readers select metadata by that payload's inode.
      await writeAtomic(root, metadataPath, JSON.stringify({
        contentType: metadata.contentType,
        customMetadata: metadata.customMetadata,
        contentHash,
        mtimeNs: String(stats.mtimeNs),
        size: Number(stats.size),
      }))
    })
    // Seed the hash cache so the read below does not hash the file again.
    // Only when the published file is still the one written here.
    const published = await stat(path, { bigint: true })
    if (written && published.dev === written.dev && published.ino === written.ino && published.size === written.size && published.mtimeNs === written.mtimeNs) {
      await writeHash(root, pathname, { contentHash, fileVersion: fileVersion(published) }).catch((error) => {
        console.error("[vitehub/blob] Filesystem hash cache write failed", error)
      })
    }
    const entry = await readEntry(root, pathname)
    return toBlobObject(entry!)
  }

  function multipartUpload(uploadId: string, state: FsMultipartState): BlobDriverMultipartUpload {
    const dir = resolveMultipartDir(root, uploadId)
    return {
      pathname: state.pathname,
      uploadId,
      async abort() {
        await assertNoSymlinkPath(root, dir)
        await rm(dir, { force: true, recursive: true })
      },
      async complete(parts) {
        await assertNoSymlinkPath(root, dir)
        const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber)
        // Copy each part into the final file in turn, so only one read buffer is in memory.
        const object = await publish(state.pathname, async (temporary) => {
          const contentHash = createHash("sha256")
          const output = await open(temporary, "wx")
          try {
            for (const part of ordered) {
              const partPath = resolve(dir, String(part.partNumber))
              await assertNoSymlinkPath(root, partPath)
              const input = await open(partPath, "r").catch((error: unknown) => {
                if (isNotFound(error)) throw blobErrorDiagnostics.BLOB_R0032({ message: `Multipart upload ${uploadId} has no part ${part.partNumber}.` })
                throw error
              })
              const etag = createHash("sha1")
              try {
                for await (const chunk of input.createReadStream({ autoClose: false })) {
                  const bytes = chunk as Buffer
                  etag.update(bytes)
                  contentHash.update(bytes)
                  for (let offset = 0; offset < bytes.length;) {
                    const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset)
                    // Internal invariant: blobResult() returns a stalled filesystem write as the cause of BLOB_OPERATION_FAILED.
                    if (bytesWritten === 0) throw new Error("Multipart output write made no progress.")
                    offset += bytesWritten
                  }
                }
              }
              finally {
                await input.close()
              }
              if (`"${etag.digest("hex")}"` !== part.etag) {
                throw blobErrorDiagnostics.BLOB_R0032({ message: `Part ${part.partNumber} of multipart upload ${uploadId} does not match its etag.` })
              }
            }
          }
          finally {
            await output.close()
          }
          return contentHash.digest("hex")
        }, { contentType: state.contentType, customMetadata: state.customMetadata })
        await rm(dir, { force: true, recursive: true })
        return object
      },
      async uploadPart(partNumber, body) {
        const bytes = await bodyToBytes(body)
        const partPath = resolve(dir, String(partNumber))
        await assertNoSymlinkPath(root, dir)
        await assertNoSymlinkPath(root, partPath)
        await writeFile(partPath, bytes)
        return { etag: partEtag(bytes), partNumber }
      },
    }
  }

  const driver: BlobDriverAdapter<ResolvedFsBlobStoreConfig> = {
    name: "fs",
    canonicalPathname: pathname => relative(root, resolveBlobPath(root, pathname)).split(sep).join("/"),
    options,
    // A file has no URL of its own. ViteHub signs a link to its signed route, which checks it and serves the file.
    sign: (pathname, signOptions, { store }) => signFsRequest(store, pathname, signOptions, options.urlBaseUrl),
    async createMultipartUpload(pathname: string, multipartOptions: BlobMultipartOptions) {
      resolveBlobPath(root, pathname)
      const uploadId = randomUUID()
      const state: FsMultipartState = {
        contentType: multipartOptions.contentType,
        customMetadata: multipartOptions.customMetadata,
        pathname,
      }
      const dir = resolveMultipartDir(root, uploadId)
      await assertNoSymlinkPath(root, dir)
      await mkdir(dir, { recursive: true })
      const statePath = resolve(dir, "state.json")
      await assertNoSymlinkPath(root, statePath)
      await writeFile(statePath, JSON.stringify(state), "utf8")
      return multipartUpload(uploadId, state)
    },
    async resumeMultipartUpload(pathname: string, uploadId: string) {
      const dir = resolveMultipartDir(root, uploadId)
      await assertNoSymlinkPath(root, dir)
      const statePath = resolve(dir, "state.json")
      await assertNoSymlinkPath(root, statePath)
      let state: FsMultipartState
      try {
        // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The state file is written by this driver and its pathname and upload ID are checked below.
        state = JSON.parse(await readFile(statePath, "utf8")) as FsMultipartState
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
        const path = resolveBlobPath(root, pathname)
        await assertNoSymlinkPath(root, path)
        const generation = await stat(path, { bigint: true }).catch((error) => {
          if (isNotFound(error)) return undefined
          throw error
        })
        if (!generation) {
          await removeMetadata(root, pathname)
          return
        }
        if (!generation.isFile()) {
          const error: NodeJS.ErrnoException = new Error(`Blob pathname is not a file: ${pathname}`)
          error.code = "EISDIR"
          throw error
        }
        // Move the payload out of the public namespace before cleaning its
        // generation metadata. This preserves the inode for cleanup while
        // avoiding Windows delete-on-close handles that keep the pathname
        // unavailable to a concurrent publisher.
        const staging = resolve(root, ".vitehub", "blob-deletes", randomUUID())
        await assertNoSymlinkPath(root, staging)
        await mkdir(dirname(staging), { recursive: true })
        try {
          try {
            await rename(path, staging)
          }
          catch (error) {
            // Another delete already moved the payload. It owns metadata
            // cleanup; touching the pathname now could affect a replacement.
            if (isNotFound(error)) return
            throw error
          }
          await removeMetadata(root, pathname, generation)
        }
        finally {
          await rm(staging, { force: true })
        }
      }))
    },
    async get(pathname) {
      try {
        const path = resolveBlobPath(root, pathname)
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await (async () => {
            try {
              await assertNoSymlinkPath(root, path)
              return await stat(path, { bigint: true })
            }
            catch (error) {
              if (isDirectoryError(error)) return null
              throw error
            }
          })()
          if (!before?.isFile()) return null
          const bytes = await readFile(path)
          let hash: string | undefined
          const meta = await readMetadata(root, pathname, before, async () => hash ??= sha256(bytes))
          if (fileVersion(before) !== fileVersion(await stat(path, { bigint: true }))) continue
          return new Blob([bytes], { type: meta.contentType || "" })
        }
        // Internal invariant: blobResult() returns this as the cause of BLOB_OPERATION_FAILED.
        throw new Error("Blob changed while reading its filesystem contents.")
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async getArrayBuffer(pathname) {
      try {
        const path = resolveBlobPath(root, pathname)
        await assertNoSymlinkPath(root, path)
        if (!(await stat(path)).isFile()) return null
        const bytes = await readFile(path)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      catch (error) {
        if (isNotFound(error) || isDirectoryError(error)) return null
        throw error
      }
    },
    async head(pathname) {
      const entry = await readEntry(root, pathname)
      return entry ? toBlobObject(entry) : null
    },
    async list(options: BlobListOptions = {}): Promise<BlobListResult> {
      const after = decodeCursor(options.cursor)
      try {
        return await listKeys(root, options, after)
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
      await assertNoSymlinkPath(root, resolveBlobPath(root, pathname))
      await assertNoSymlinkPath(root, resolveMetaPath(root, pathname))
      const bytes = await bodyToBytes(body)
      return await publish(pathname, async (temporary) => {
        await writeFile(temporary, bytes, { flag: "wx" })
        return sha256(bytes)
      }, { contentType: putOptions.contentType || (isBlob(body) ? body.type : undefined), customMetadata: putOptions.customMetadata })
    },
    // Copies the file, then writes the metadata of the source for the new file.
    async copy(from, to) {
      const source = await readEntry(root, from)
      if (!source) return null
      const sourcePath = resolveBlobPath(root, from)
      await assertNoSymlinkPath(root, sourcePath)
      return publish(to, async (temporary) => {
        await copyFile(sourcePath, temporary, constants.COPYFILE_EXCL)
        return sha256File(temporary)
      }, source.meta)
    },
  }

  return driver
}
