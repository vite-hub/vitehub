import { formatDiagnostic } from "nostics"

import { parserHash } from "./commit-cache.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentKV } from "./kv.ts"

import type { GitHubFileCommit } from "@vite-hub/source"
import type { ContentRevision, ContentRevisionsOptions, ContentRevisionsResult, ContentResolved } from "./collections-runtime.ts"
import type { GitHubDefinition } from "./source-heads.ts"

/** One published change of a page. Collection revisions and GitHub commits have this one shape. */
export interface ContentHistoryEntry {
  /** The revision id, or the commit SHA for a `github()` Source. */
  id: string
  /** When the change was made, as an ISO date. */
  at: string
  /** Who made it: the GitHub login or Git author name, or the `author` of the revision metadata. Null when unknown. */
  author: string | null
  /** The first line of the revision or commit message. */
  message: string
  /** The commit page on GitHub, or null when the store has no web page for the revision. */
  url: string | null
}

export interface ContentHistoryOptions {
  /** Entries to return, default 20, at most 100. */
  limit?: number
  /** `cursor` from the previous call. */
  cursor?: string
}

export interface ContentHistoryResult {
  /** Newest first. */
  entries: ContentHistoryEntry[]
  /** Pass to the next call to continue. Absent when the history is exhausted. */
  cursor?: string
}

/** What `content.history()` reads from the Content runtime. */
export interface ContentHistoryRuntime {
  /** The published collection document at an app path, or null. Undefined without collections. */
  resolve?: (path: string) => Promise<ContentResolved | null>
  /** Published revisions of one collection document. */
  revisions: (collection: string, id: string, options: ContentRevisionsOptions) => Promise<ContentRevisionsResult>
  /** The Source name and Source key of the page at an app path, or null. */
  page: (path: string) => Promise<{ source: string, key: string } | null>
  /** The `github()` definition of a Source, or undefined for other Sources. */
  github: (source: string) => GitHubDefinition | undefined
  /** The commit that readers get from a `github()` Source. */
  published: (source: string) => Promise<string | null>
}

/** GitHub commits per cached page. A page at one commit never changes, so Content caches it without expiry. */
const pageSize = 100
/** Pages that one server instance holds in memory. */
const memoryPages = 256

type CommitPage = { commits: GitHubFileCommit[], more: boolean }

function limitOf(options: ContentHistoryOptions): number {
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.history() limit must be an integer from 1 to 100." })
  }
  return limit
}

function authorOf(metadata: Record<string, unknown> | undefined): string | null {
  const author = metadata?.author
  if (typeof author === "string" && author) return author
  if (author !== null && typeof author === "object") {
    const name: unknown = Reflect.get(author, "name") ?? Reflect.get(author, "id")
    if (typeof name === "string" && name) return name
  }
  return null
}

function revisionEntry(revision: ContentRevision): ContentHistoryEntry {
  const url = revision.metadata?.url
  return {
    id: revision.id,
    at: revision.createdAt,
    author: authorOf(revision.metadata),
    message: (revision.message ?? "").split("\n", 1)[0]!.trim(),
    url: typeof url === "string" && url ? url : null,
  }
}

/** Create `content.history()`. */
export function createContentHistory(runtime: ContentHistoryRuntime) {
  const pages = new Map<string, Promise<CommitPage>>()
  const warned = new Set<string>()

  /** One page of commits, from memory, then KV, then GitHub. A failed read is not kept. */
  async function commitPage(cacheKey: string, load: () => Promise<CommitPage>): Promise<CommitPage> {
    let pending = pages.get(cacheKey)
    if (pending) {
      // Move the page to the end, so the oldest page leaves first.
      pages.delete(cacheKey)
      pages.set(cacheKey, pending)
      return await pending
    }
    pending = (async () => {
      const kv = contentKV()
      if (!kv) return await load()
      // KV is only a cache here. When it fails, Content reads GitHub. `content.sources` reports KV failures.
      const [error, stored] = await kv.get<CommitPage>(cacheKey).catch((cause: unknown) => [cause, undefined] as const)
      if (!error && stored) return stored
      const loaded = await load()
      await kv.set(cacheKey, loaded).catch(() => undefined)
      return loaded
    })()
    pages.set(cacheKey, pending)
    pending.catch(() => {
      if (pages.get(cacheKey) === pending) pages.delete(cacheKey)
    })
    while (pages.size > memoryPages) pages.delete(pages.keys().next().value!)
    return await pending
  }

  async function sourceHistory(source: string, key: string, limit: number, cursor: string | undefined): Promise<ContentHistoryResult> {
    const definition = runtime.github(source)
    if (!definition?.history) return { entries: [] }
    if (!await definition.authenticated()) {
      if (!warned.has(source)) {
        warned.add(source)
        console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0040({ source })))
      }
      return { entries: [] }
    }
    // The cursor of a Source page is the number of commits that earlier calls returned.
    let position = cursor === undefined ? 0 : Number(cursor)
    if (cursor !== undefined && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(position))) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.history() received the cursor ${JSON.stringify(cursor)}, which is not a cursor of a Source page. Pass the cursor of the previous call.` })
    }
    const sha = await runtime.published(source)
    if (!sha) return { entries: [] }
    // The Source options, such as `root`, decide which file a key is. Another origin gets other cache keys.
    const origin = await parserHash(definition.fingerprint ?? null)
    const entries: ContentHistoryEntry[] = []
    let exhausted = false
    while (entries.length < limit && !exhausted) {
      const page = Math.floor(position / pageSize) + 1
      const loaded = await commitPage(`content:history:${source}:${origin}:${sha}:${key}:${page}`, () => definition.history!(key, { sha, page, perPage: pageSize }))
      const start = position % pageSize
      const taken = loaded.commits.slice(start, start + limit - entries.length)
      for (const commit of taken) entries.push({ id: commit.sha, at: commit.date, author: commit.author, message: commit.message, url: commit.url })
      position += taken.length
      // An empty slice of a page with more pages would loop, so it ends the history too.
      exhausted = !taken.length || (!loaded.more && start + taken.length >= loaded.commits.length)
    }
    return exhausted ? { entries } : { entries, cursor: String(position) }
  }

  /**
   * The published history of the page at an app path, newest first. Null when no page has that path.
   */
  return async function history(path: string, options: ContentHistoryOptions = {}): Promise<ContentHistoryResult | null> {
    if (typeof path !== "string" || !path) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.history() requires an app path such as \"/docs/guide\"." })
    }
    if (options === null || typeof options !== "object") {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.history() options must be an object." })
    }
    const limit = limitOf(options)
    const document = await runtime.resolve?.(path)
    if (document) {
      const page = await runtime.revisions(document.collection, document.id, {
        ref: "published",
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(document.locale === undefined ? {} : { locale: document.locale }),
      })
      return { entries: page.revisions.map(revisionEntry), ...(page.cursor ? { cursor: page.cursor } : {}) }
    }
    const page = await runtime.page(path)
    return page ? await sourceHistory(page.source, page.key, limit, options.cursor) : null
  }
}
