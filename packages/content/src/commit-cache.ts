import { buildArtifact, readArtifact } from "comark-content"
import type { CacheArtifact, ContentFile, Manifest, ParsedSource, Source as ComarkContentSource } from "comark-content"
import type { SourceItem } from "@vite-hub/source"

/**
 * The commit cache of `github()` Sources. The files of a commit never change, so Content keeps them and the parsed
 * documents under `content:<parserHash>:<sha>:<source>`. A new head reads new keys. Reads try memory first, then
 * ViteHub KV, and only then download the archive. Custom plugins reparse cached files in each new runtime, because
 * their effective configuration can be hidden in closures.
 */

type ContentSourceItem = SourceItem<string, unknown, object>

/** One commit of one Source: its files, and its documents parsed with one parser config. */
export interface ContentCommit {
  files: ContentSourceItem[]
  manifest: Manifest
  items: ContentFile[]
}

/** How a Source used the commit cache in this server instance. */
export interface ContentCommitCacheStats {
  /** The key of the commit that Content serves, such as `content:3f2a…:9c1e…:docs`, or null without a head. */
  key: string | null
  /** Reads served from memory, and from ViteHub KV. */
  hits: { memory: number, kv: number }
  /** Reads that found no entry, so Content downloaded the archive of the commit and parsed it. */
  misses: number
}

/** A file in a KV entry. Valid UTF-8 bytes are text, so the entry gzips well. Other bytes are base64. */
type StoredFile = Omit<ContentSourceItem, "content"> & { text?: string, bytes?: "utf8" | "base64" }

interface StoredCommit {
  files: StoredFile[]
  manifest: Manifest
  items: ContentFile[]
}

/** The commits that one server instance keeps in memory. Each holds the files and documents of a whole Source. */
export const MEMORY_COMMITS = 4

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function storeFile({ content, ...file }: ContentSourceItem): StoredFile {
  if (content === undefined) return file
  if (typeof content === "string") return { ...file, text: content }
  try {
    return { ...file, text: utf8.decode(content), bytes: "utf8" }
  }
  catch {
    return { ...file, text: base64(content), bytes: "base64" }
  }
}

function readFile({ text, bytes, ...file }: StoredFile): ContentSourceItem {
  if (text === undefined) return file
  if (bytes === "utf8") return { ...file, content: new TextEncoder().encode(text) }
  if (bytes === "base64") return { ...file, content: fromBase64(text) }
  return { ...file, content: text }
}

/** The KV value of a commit: gzipped JSON with a checksum. */
export async function encodeCommit(name: string, commit: ContentCommit): Promise<CacheArtifact> {
  const stored: StoredCommit = { files: commit.files.map(storeFile), manifest: commit.manifest, items: commit.items }
  return await buildArtifact(name, JSON.stringify(stored))
}

export async function decodeCommit(artifact: CacheArtifact): Promise<ContentCommit> {
  const stored = await readArtifact<StoredCommit>(artifact)
  return { files: stored.files.map(readFile), manifest: stored.manifest, items: stored.items }
}

/**
 * Plain JSON of a config. Functions count by their source text, which cannot include captured values. The walk stops
 * at depth 8, because a plugin can hold a client with a large object graph.
 */
function configText(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function") return `function:${String(value)}`
  if (typeof value === "bigint" || typeof value === "symbol") return String(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[circular]"
  if (depth > 8) return "[deep]"
  seen.add(value)
  const read = (key: string) => {
    try {
      return configText(Reflect.get(value, key), depth + 1, seen)
    }
    catch {
      return "[unreadable]"
    }
  }
  const result = Array.isArray(value)
    ? value.map((_, index) => read(String(index)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, read(key)]))
  seen.delete(value)
  return result
}

/**
 * A hash of the parser config: the Comark options, the source text of every Markdown and Content plugin, and the Source
 * fingerprint. This cannot identify captured plugin options or implementations; callers must reparse their cached files.
 */
export async function parserHash(config: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(configText(config))))
  return [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** The key of one commit of one Source. */
export function commitKey(hash: string, sha: string, source: string): string {
  return `content:${hash}:${sha}:${source}`
}

/** A small least-recently-used map. */
export class CommitMemory<T> {
  readonly #entries = new Map<string, T>()
  constructor(readonly max: number = MEMORY_COMMITS) {}

  get size(): number {
    return this.#entries.size
  }

  delete(key: string): void {
    this.#entries.delete(key)
  }

  get(key: string): T | undefined {
    const value = this.#entries.get(key)
    if (value === undefined) return
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  set(key: string, value: T): void {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value!)
  }
}

/**
 * A Comark parsed Source over the cached documents of one commit. `load` returns the commit that the instance serves, or
 * undefined to read `origin` as it is. `refresh()` still parses `origin`, whose files come from the same cache.
 */
export function withCommitDocuments(origin: ComarkContentSource, load: () => Promise<ContentCommit | undefined>): ParsedSource {
  const byKey = new WeakMap<ContentCommit, Map<string, ContentFile>>()
  const documents = async () => {
    const commit = await load()
    if (!commit) return
    let index = byKey.get(commit)
    if (!index) {
      index = new Map(commit.items.map(item => [item.meta.key.slice(item.meta.key.indexOf("/") + 1), item]))
      byKey.set(commit, index)
    }
    return { commit, index }
  }
  // Comark changes the manifest and documents that it holds, such as on `refresh()`. It gets copies, so the cached commit
  // stays as it was parsed. There is no `manifest()` tier: each init loads the snapshot, so index plugins such as
  // `sql-query` rebuild their tables at the served commit and never keep the rows of another commit.
  return {
    parsed: true,
    origin,
    ...(origin.schema ? { schema: origin.schema } : {}),
    async get(key) {
      const item = (await documents())?.index.get(key)
      return item && structuredClone(item)
    },
    async snapshot() {
      const loaded = await documents()
      return loaded && { items: structuredClone(loaded.commit.items), time: loaded.commit.manifest.time }
    },
  }
}
