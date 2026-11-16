import { BoundedMap } from "./bounded-map.ts";

/**
 * The GitHub answers that the GitHub Store keeps. An answer for a URL that names a commit or tree sha never
 * changes, so it goes to the shared KV store when the app has one: another server instance reads it there and sends no
 * request. Other answers stay in memory with their ETag. The next read of the same URL asks GitHub with
 * `If-None-Match`, and a `304 Not Modified` does not count against the GitHub rate limit.
 */

/** The part of a ViteHub KV store that the GitHub Store uses, such as `kv` from `@vite-hub/kv`. */
export interface WorkspaceKV {
  get<T>(key: string): Promise<readonly [unknown, T | null | undefined]>
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<readonly [unknown, unknown]>
}

/** How long a kept answer stays in KV, in seconds. A commit that nobody reads for a week leaves KV. */
const kvTTL = 7 * 24 * 60 * 60

/** One kept answer. `body` is text for JSON and base64 for bytes. */
interface StoredAnswer {
  body: string
  encoding?: "base64"
  etag?: string
  headers: Record<string, string>
}

/** How the GitHub Store answered its reads in this server instance. */
export interface GitHubReadStats {
  /** Requests that reached GitHub, including the conditional ones. */
  requests: number
  /** Conditional requests that GitHub answered with `304 Not Modified`. They do not count against the rate limit. */
  notModified: number
  /** Answers that came from memory or from the shared KV store, with no request. */
  memory: number
  kv: number
}

const stats: GitHubReadStats = { requests: 0, notModified: 0, memory: 0, kv: 0 }
let installedKV: WorkspaceKV | undefined
/** The answers that one repository connection keeps in memory. */
export interface GitHubReadMemory {
  /** ETag answers by URL, for URLs that can change. */
  conditional: BoundedMap<string, StoredAnswer>
  /** Answers of immutable URLs, the most recently used last, up to `maxMemoryBytes` in all. */
  immutable: BoundedMap<string, StoredAnswer>
  immutableBytes: number
}

const maxMemoryBytes = 12 * 1024 * 1024

export function createGitHubReadMemory(): GitHubReadMemory {
  return { conditional: new BoundedMap(256), immutable: new BoundedMap(Number.MAX_SAFE_INTEGER), immutableBytes: 0 }
}
const keptHeaders = ["content-type", "etag", "link"]
/** The largest answer that goes to KV. Cloudflare KV takes up to 25 MiB a value. */
const maxStoredBytes = 16 * 1024 * 1024
const sha = "[0-9a-f]{40}"
// Blobs are not here: `readGitHubFile()` keeps their bytes once their sha checks out, so a bad answer is never kept.
const immutablePaths = [
  new RegExp(`/repos/[^/]+/[^/]+/git/(?:trees|commits)/${sha}$`, "i"),
  new RegExp(`/repos/[^/]+/[^/]+/commits/${sha}$`, "i"),
  new RegExp(`/repos/[^/]+/[^/]+/compare/${sha}\\.\\.\\.${sha}$`, "i"),
]
const commitList = /\/repos\/[^/]+\/[^/]+\/commits$/
const shaPattern = new RegExp(`^${sha}$`, "i")

/**
 * Give the GitHub Store a shared KV store for the GitHub answers that never change. The Content build calls it with
 * ViteHub KV when the app enables KV; without it, each server instance asks GitHub again after it starts.
 */
export function registerWorkspaceKV(store: WorkspaceKV | undefined): void {
  installedKV = store
}

/** The reads of the GitHub Store in this server instance, for tests and inspection. */
export function readGitHubReadStats(): GitHubReadStats {
  return { ...stats }
}

/** Whether the answer for `url` can never change: it names a commit or tree sha. */
export function isImmutableGitHubUrl(url: URL): boolean {
  if (immutablePaths.some(pattern => pattern.test(url.pathname))) return true
  return commitList.test(url.pathname) && shaPattern.test(url.searchParams.get("sha") ?? "")
}

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** The KV key of an answer, such as `workspace:github:onmax/repo:3f2a…`. */
export async function githubKVKey(scope: string, id: string): Promise<string> {
  return `workspace:github:${scope}:${await hash(id)}`
}

function repositoryOf(url: URL): string {
  return /\/repos\/([^/]+\/[^/]+)/.exec(url.pathname)?.[1] ?? url.host
}

function answer(stored: StoredAnswer): Response {
  const body = stored.encoding === "base64" ? fromBase64(stored.body) : stored.body
  return new Response(body, { status: 200, headers: stored.headers })
}

async function store(response: Response): Promise<StoredAnswer | undefined> {
  const headers: Record<string, string> = {}
  for (const name of keptHeaders) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  const body = await response.text()
  if (body.length > maxStoredBytes) return undefined
  return { body, headers, ...(headers.etag ? { etag: headers.etag } : {}) }
}

/** Read a value from KV. A KV failure is a miss: the read goes to GitHub. */
export async function readWorkspaceKV<T>(key: string): Promise<T | undefined> {
  if (!installedKV) return undefined
  try {
    const [error, value] = await installedKV.get<T>(key)
    return error || value === null ? undefined : value
  }
  catch {
    return undefined
  }
}

/** Write a value to KV. A failed write only costs a later read. */
export async function writeWorkspaceKV<T>(key: string, value: T): Promise<void> {
  if (!installedKV) return
  try {
    await installedKV.set(key, value, { ttl: kvTTL })
  }
  catch {
    // The answer stays correct without the shared copy.
  }
}

/** Whether a shared KV store is registered. */
export function hasWorkspaceKV(): boolean {
  return Boolean(installedKV)
}

/**
 * `fetch` for one GitHub read, with the shared answers of immutable URLs and the ETag of other URLs. Other methods,
 * other headers that change the answer, and non-200 answers pass through.
 */
export async function fetchGitHubRead(memory: GitHubReadMemory, input: string | URL | Request, init: RequestInit, send: (init: RequestInit) => Promise<Response>): Promise<Response> {
  const method = (init.method || "GET").toUpperCase()
  if (method !== "GET" || input instanceof Request) return await counted(send(init))
  const url = new URL(String(input))
  const headers = new Headers(init.headers)
  if (headers.has("range") || headers.has("if-none-match")) return await counted(send(init))
  const id = `${url.href}\n${headers.get("accept") ?? ""}`
  if (isImmutableGitHubUrl(url)) {
    const kept = memory.immutable.get(id)
    if (kept) {
      stats.memory++
      return answer(kept)
    }
    const key = installedKV ? await githubKVKey(repositoryOf(url), id) : undefined
    const shared = key ? await readWorkspaceKV<StoredAnswer>(key) : undefined
    if (shared) {
      stats.kv++
      remember(memory, id, shared)
      return answer(shared)
    }
    const response = await counted(send(init))
    if (response.status !== 200 || response.headers.get("content-type")?.includes("json") !== true) return response
    const stored = await store(response.clone())
    if (stored) {
      remember(memory, id, stored)
      if (key) await writeWorkspaceKV(key, stored)
    }
    return response
  }
  const previous = memory.conditional.get(id)
  if (previous?.etag) headers.set("if-none-match", previous.etag)
  const response = await counted(send({ ...init, headers }))
  if (previous && response.status === 304) {
    stats.notModified++
    await response.body?.cancel().catch(() => undefined)
    return answer(previous)
  }
  if (response.status === 200 && response.headers.get("etag") && response.headers.get("content-type")?.includes("json")) {
    const stored = await store(response.clone())
    if (stored && stored.body.length <= 1024 * 1024) memory.conditional.set(id, stored)
  }
  return response
}

/** Keep an immutable answer in memory, the least recently used out first. */
function remember(memory: GitHubReadMemory, id: string, stored: StoredAnswer): void {
  if (stored.body.length > maxMemoryBytes / 4 || memory.immutable.has(id)) return
  memory.immutable.set(id, stored)
  memory.immutableBytes += stored.body.length
  for (const [oldest, entry] of memory.immutable) {
    if (memory.immutableBytes <= maxMemoryBytes) break
    memory.immutable.delete(oldest)
    memory.immutableBytes -= entry.body.length
  }
}

async function counted(response: Promise<Response>): Promise<Response> {
  stats.requests++
  return await response
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
