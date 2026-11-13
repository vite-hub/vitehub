import { formatDiagnostic } from "nostics"

import { parserHash } from "./commit-cache.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentKV } from "./kv.ts"

import type { GitHubFileCommit } from "@vite-hub/source"
import type { LeaseStore } from "@vite-hub/runtime"
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
  /** An atomic authority shared by every instance that refreshes Source dates. */
  dateLeases?: LeaseStore
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

/** What `createContentHistory()` gives the Content runtime. */
export interface ContentHistoryApi {
  /** `content.history()`. */
  history(path: string, options?: ContentHistoryOptions): Promise<ContentHistoryResult | null>
  /**
   * The date of the latest commit of each Source page at the published commit, by Source key. Empty without history or
   * a GitHub token. A key without commits has no entry.
   */
  dates(source: string, keys: readonly string[], options?: ContentDatesOptions): Promise<Map<string, string>>
  /** Compute the date set of the published commit of a Source, as `dates()` with `waitUntil` does after the response. */
  refresh(source: string, keys: readonly string[]): Promise<void>
}

export interface ContentDatesOptions {
  /**
   * The `waitUntil` of the request. When the dates of the published commit are not ready, `dates()` answers at once
   * with the dates of the previous head and computes the new set in `waitUntil`. Without it, `dates()` waits for them.
   * When another instance holds `dateLeases`, either form serves cached dates until the new set is visible.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

/** The latest commit dates of the pages of one Source at one commit. Null for a page without commits. */
type SourceDates = { sha: string, dates: Record<string, string | null> }

/** Seconds before another instance may retry a date set. A cold set takes about 20 seconds. */
const datesLease = 60

/** Create `content.history()`. */
export function createContentHistory(runtime: ContentHistoryRuntime): ContentHistoryApi {
  const pages = new Map<string, Promise<CommitPage>>()
  const warned = new Set<string>()
  /** All in-flight date work, shared by blocking reads, background reads, and webhook warming. */
  const dateSets = new Map<string, Promise<SourceDates | undefined>>()
  /** The newest date set of each Source and origin, so the next commit reads only the pages that changed. */
  const lastDates = new Map<string, SourceDates>()

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

  /** Whether a Source has history to read. Without a token it logs CONTENT_R0040 once per Source. */
  async function readable(source: string): Promise<boolean> {
    const definition = runtime.github(source)
    if (!definition?.history) return false
    if (await definition.authenticated()) return true
    if (!warned.has(source)) {
      warned.add(source)
      console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0040({ source })))
    }
    return false
  }

  async function sourceHistory(source: string, key: string, limit: number, cursor: string | undefined): Promise<ContentHistoryResult> {
    if (!await readable(source)) return { entries: [] }
    const definition = runtime.github(source)!
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
  async function history(path: string, options: ContentHistoryOptions = {}): Promise<ContentHistoryResult | null> {
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

  async function readSet(key: string): Promise<SourceDates | undefined> {
    const kv = contentKV()
    if (!kv) return
    const [error, stored] = await kv.get<SourceDates>(key).catch((cause: unknown) => [cause, undefined] as const)
    return !error && stored && stored.sha && stored.dates ? stored : undefined
  }

  /** The date set of `sha` from memory or KV, when it has every key. */
  async function readySet(prefix: string, sha: string, keys: readonly string[]): Promise<SourceDates | undefined> {
    const current = lastDates.get(prefix)?.sha === sha ? lastDates.get(prefix) : await readSet(`${prefix}:${sha}`)
    return current && keys.every(key => Object.hasOwn(current.dates, key)) ? current : undefined
  }

  /**
   * The dates of `keys` at `sha`, from memory, then KV, then GitHub. GitHub gets the pages that changed since the last
   * date set (one compare request), or every page when there is none, in GraphQL requests of 150 pages.
   */
  async function sourceDates(definition: GitHubDefinition, prefix: string, sha: string, keys: readonly string[]): Promise<SourceDates> {
    const kv = contentKV()
    let current = lastDates.get(prefix)?.sha === sha ? lastDates.get(prefix) : await readSet(`${prefix}:${sha}`)
    if (current && keys.every(key => Object.hasOwn(current!.dates, key))) return current
    let known: Record<string, string | null> = current?.dates ?? {}
    if (!current) {
      const previous = lastDates.get(prefix) ?? await readSet(`${prefix}:last`)
      const changed = previous && previous.sha !== sha ? await definition.changes!(previous.sha, sha) : undefined
      if (previous && changed) {
        known = { ...previous.dates }
        for (const key of changed) delete known[key]
      }
    }
    const missing = keys.filter(key => !Object.hasOwn(known, key))
    const found = missing.length ? await definition.latest!(missing, { sha }) : new Map()
    // Only the pages at this commit, so a removed page leaves the set.
    const dates = Object.fromEntries(keys.map(key => [key, Object.hasOwn(known, key) ? known[key]! : found.get(key)?.date ?? null]))
    current = { sha, dates }
    lastDates.set(prefix, current)
    if (kv) await Promise.all([kv.set(`${prefix}:${sha}`, current), kv.set(`${prefix}:last`, current)]).catch(() => undefined)
    return current
  }

  /**
   * Share work for this Source/head across every entry point. Cross-instance exclusion needs an atomic LeaseStore;
   * eventually consistent KV is only a date cache. Keep a successful lease until expiry to allow cache propagation.
   */
  function refreshSet(definition: GitHubDefinition, prefix: string, sha: string, keys: readonly string[]): Promise<SourceDates | undefined> {
    const id = `${prefix}:${sha}`
    const running = dateSets.get(id)
    if (running) {
      // A caller can request more keys than the work already in flight. Fill those after it completes.
      return running.then(current => current && keys.some(key => !Object.hasOwn(current.dates, key))
        ? refreshSet(definition, prefix, sha, keys)
        : current)
    }
    const task = (async () => {
      const [error, lease] = runtime.dateLeases ? await runtime.dateLeases.acquire(id, { ttl: datesLease }) : []
      // A failed authority must not silently turn into uncoordinated upstream work.
      if (error) throw error
      if (runtime.dateLeases && !lease) return await readySet(prefix, sha, keys)
      try {
        return await sourceDates(definition, prefix, sha, keys)
      }
      catch (error) {
        await lease?.release().catch(() => undefined)
        throw error
      }
    })().finally(() => dateSets.delete(id))
    dateSets.set(id, task)
    return task
  }

  /** The `github()` definition, published commit, and KV prefix of a Source with dates, or undefined. */
  async function datesTarget(source: string): Promise<{ definition: GitHubDefinition, sha: string, prefix: string } | undefined> {
    if (!await readable(source)) return
    const definition = runtime.github(source)!
    if (!definition.latest || !definition.changes) return
    const sha = await runtime.published(source)
    if (!sha) return
    return { definition, sha, prefix: `content:dates:${source}:${await parserHash(definition.fingerprint ?? null)}` }
  }

  async function dates(source: string, keys: readonly string[], options: ContentDatesOptions = {}): Promise<Map<string, string>> {
    if (!keys.length) return new Map()
    const pick = (stored: Record<string, string | null>) => new Map(keys.flatMap(key => Object.hasOwn(stored, key) && stored[key] ? [[key, stored[key]] as const] : []))
    const previousSet = async (prefix: string) => lastDates.get(prefix) ?? await readSet(`${prefix}:last`)
    let prefix: string | undefined
    try {
      const target = await datesTarget(source)
      if (!target) return new Map()
      const { definition, sha } = target
      prefix = target.prefix
      if (options.waitUntil) {
        const ready = await readySet(prefix, sha, keys)
        if (ready) return pick(ready.dates)
        // Answer now with the dates of the previous head, and compute this head after the response.
        options.waitUntil(refreshSet(definition, prefix, sha, keys).catch(error => console.warn(error)))
        const previous = await previousSet(prefix)
        return previous ? pick(previous.dates) : new Map()
      }
      const ready = await readySet(prefix, sha, keys)
      if (ready) return pick(ready.dates)
      const current = await refreshSet(definition, prefix, sha, keys) ?? await previousSet(prefix)
      return current ? pick(current.dates) : new Map()
    }
    catch (error) {
      // The dates only enrich the sitemap and the feed, so a GitHub failure keeps the dates of the previous head, or
      // none. The failed set is not stored, so the next request asks again.
      console.warn(`[vitehub] Content could not read the page dates of Source ${JSON.stringify(source)}, so its pages keep older dates or none: ${error instanceof Error ? error.message : String(error)}`)
      const previous = prefix ? await previousSet(prefix) : undefined
      return previous ? pick(previous.dates) : new Map()
    }
  }

  async function refresh(source: string, keys: readonly string[]): Promise<void> {
    const target = keys.length ? await datesTarget(source) : undefined
    if (target) await refreshSet(target.definition, target.prefix, target.sha, keys)
  }

  return { history, dates, refresh }
}
