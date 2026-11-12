import { AsyncLocalStorage } from "node:async_hooks"

import { createSource } from "@vite-hub/source"
import type { GitHubPullRequest, GitHubRef, GitHubRefTarget, Source, SourceItem, SourceRevision } from "@vite-hub/source"
import { contentHub } from "comark-content"
import type { CacheArtifact, ComarkContent, ContentHub, ContentOptions } from "comark-content"
import { formatDiagnostic } from "nostics"

import { CommitMemory, commitKey, decodeCommit, encodeCommit, parserHash, withCommitDocuments } from "./commit-cache.ts"
import { contentSource, contentSourceDefinition, createContentInstance } from "./content-source.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentRefGrant, signContentRefToken } from "./preview.ts"
import { ACCESS_HOLD_MS, isPrivateRef, publicRule } from "./source-access.ts"
import { parseContentRef } from "./source-refs.ts"

import type { ContentCommit, ContentCommitCacheStats } from "./commit-cache.ts"
import type { ContentSourceCommits, ContentSourceInput } from "./content-source.ts"
import type { ContentPreviewOptions, ContentPreviewToken } from "./preview.ts"
import type { ContentSourceAccess, ContentSourceAllowReason, ContentSourceDenyReason } from "./source-access.ts"
import type { ContentSourceRef, ParsedContentRef } from "./source-refs.ts"

/**
 * The commit that Content serves for a `github()` Source. Content keeps it in ViteHub KV and moves it only to a commit
 * whose documents all load and parse, so a push with a broken document never reaches readers.
 */
export interface ContentSourceHead {
  /** The Content source name, such as `default` or `docs`. */
  source: string
  /** True when Content serves the Source from a head commit. False without a GitHub token or a KV store. */
  live: boolean
  /** The commit that Content serves, or null when the Source is not live or no commit passed validation yet. */
  sha: string | null
  /** The branch that the head follows, such as `main`. */
  ref: string | null
  /** When the head last moved, as an ISO date. */
  movedAt: string | null
  /** True after `pin()`. `advance()` keeps the head until `unpin()`. */
  pinned: boolean
  /** The newest commit that failed validation, and why. Null after the head moves past it. */
  rejected: { sha: string, at: string, reason: string } | null
  /** How this server instance read commits of the Source: from memory, from ViteHub KV, or from a GitHub archive. */
  cache: ContentCommitCacheStats
  /** The commits of the Source that this server instance holds open for `at()`, the most recently used last. */
  views: string[]
}

/**
 * A read view of one commit of a `github()` Source, from `content.sources.at()`. It has the read methods of Content for
 * that Source only. The commit does not change for the life of the view.
 */
export interface ContentSourceView extends ContentSourceRef {
  get: ContentHub["get"]
  list: ContentHub["list"]
  navigation: ContentHub["navigation"]
  search: ContentHub["search"]
}

/**
 * The head commits of `github()` Sources. Serialize first initialization and mutations per Source through one writer.
 * KV has no atomic conditional writes; concurrent writers are unsupported. Read replicas follow provider consistency.
 */
export interface ContentSourceHeads {
  /** The head of a `github()` Source. The first call resolves its branch, validates the commit, and stores it in KV. */
  head(source?: string): Promise<ContentSourceHead>
  /**
   * Resolve the branch to its latest commit and move the head there when every document of that commit loads and
   * parses. A commit that fails stays out: the head keeps the last valid commit and `rejected` names the failure.
   * A pinned head does not move.
   */
  advance(source?: string): Promise<ContentSourceHead>
  /** Serve this full commit SHA until `unpin()`, for example to roll back. The commit must pass validation. */
  pin(sha: string, source?: string): Promise<ContentSourceHead>
  /** Remove the pin and advance to the latest valid commit. */
  unpin(source?: string): Promise<ContentSourceHead>
  /**
   * A read view of a `github()` Source at a ref: a full commit SHA, a branch such as `feat/x`, or `pr/<number>` for the
   * head commit of a pull request. Content resolves the ref to a commit SHA on GitHub and holds that lookup for 30
   * seconds. The commit must pass the same validation as a head.
   *
   * `at()` does not check access, and Content serves no route for it. Draft branches and fork pull requests can hold
   * content that is not public. Call `allow()` first and pass its `target`, so the view reads the commit it allowed.
   */
  at(ref: string | ContentSourceRef, source?: string): Promise<ContentSourceView>
  /**
   * Decide whether a request may read a ref of a `github()` Source, before Content downloads the commit. A ref is public
   * when the published branch contains its commit, or when the commit is the head of an open or merged pull request from
   * the same repository, or from a fork with the `preview:enabled` label. Private branches, such as the CMS draft
   * branch and the `vitehub/publish/*` branches of CMS pull requests, and every other ref need the preview cookie of
   * `content.preview.enable()` or a link from `sign()`.
   *
   * Content holds a decision from GitHub for 10 minutes. An invalid or unknown ref is denied with `missing`, so answer a
   * plain 404 for every denial. It throws `CONTENT_R0029` or `CONTENT_R0032` when GitHub does not answer.
   */
  allow(ref: string | ContentSourceRef, request: Request, source?: string): Promise<ContentSourceAccess>
  /**
   * Sign a link token for one ref of a `github()` Source, such as the CMS draft branch. A request with
   * `?vitehub-content-token=<token>` passes `allow()` for this ref until the token expires. It uses `VITEHUB_CONTENT_KEY`,
   * like `content.preview`. This is trusted server API: check `content.can()` or Console access before you call it.
   */
  sign(ref: string, source?: string, options?: ContentPreviewOptions): Promise<ContentPreviewToken>
}

/** A `github()` Source definition. */
type GitHubDefinition = Source<string, unknown, object> & {
  authenticated(): Promise<boolean>
  resolveRef?(ref: GitHubRef, options?: { signal?: AbortSignal }): Promise<GitHubRefTarget | undefined>
  contains?(sha: string, options?: { signal?: AbortSignal }): Promise<boolean>
  pullsAt?(sha: string, options?: { signal?: AbortSignal }): Promise<GitHubPullRequest[]>
}

/** The KV value of a head. */
interface StoredHead {
  /** The Source fingerprint the head belongs to. A head of another repository or ref is ignored. */
  origin: string
  sha: string | null
  ref: string | null
  movedAt: string | null
  pinned: boolean
  rejected: ContentSourceHead["rejected"]
}

/** One commit loaded through the commit cache. `commit` is missing when a document does not parse, and `reason` says why. */
interface LoadedCommit {
  files: SourceItem<string, unknown, object>[]
  commit?: ContentCommit
  reason?: string
}

interface HeadState {
  name: string
  input: ContentSourceInput
  definition: GitHubDefinition
  /** The parser hash of the commit cache keys. */
  hash?: Promise<string>
  stats: { memory: number, kv: number, misses: number }
  instance?: ComarkContent
  /** Whether the Source has a token and the app a KV store. Checked once per server instance. */
  live?: Promise<boolean>
  /** The head read from KV, held in memory until `at + HOLD_MS`. */
  held?: { head: StoredHead | null, at: number }
  reading?: Promise<StoredHead | null>
  /** The commit that the instance reads on its next load. */
  served?: { sha: string, ref: string | null }
  /** The last revision successfully loaded by an initialized instance. */
  loaded?: string
  access: AsyncLocalStorage<boolean>
  /** The reload of the instance after the head moved. Reads wait for it. */
  refreshing?: Promise<void>
  /** Rejected commits that this server instance already reported. */
  reported: Set<string>
  /** When KV last failed on a read. Reads skip KV until `failed + HOLD_MS`. */
  failed?: number
}

/** One commit that `at()` holds open, with its own Comark instance. */
interface OpenView {
  key: string
  state: HeadState
  sha: string
  instances: ComarkContent[]
  /** The ref instance of the commit. Its plugin tables and rows are dropped when the view closes. */
  view: ComarkContent
  hub: ContentHub<ComarkContent[]>
  /** Reads that run now. An evicted view closes after the last one. */
  readers: number
  evicted: boolean
  idle?: () => void
  closing?: Promise<void>
}

/** How long a server instance serves a head before it reads KV again. */
const HOLD_MS = 5_000
/** How long a server instance holds the commit that a branch or pull request ref resolved to. */
const REF_HOLD_MS = 30_000
/** The ref lookups that one server instance holds. */
const MAX_HELD_REFS = 64
/** The views of `at()` that one server instance holds open. Each one holds the parsed documents of a whole commit. */
export const MAX_SOURCE_VIEWS = 8
/** The access decisions from GitHub that one server instance holds. */
const MAX_HELD_DECISIONS = 256
const fullSha = /^[0-9a-f]{40}$/i

/** The `CONTENT_R0031` message for each denial. It names the rule, never what GitHub has. */
const denyMessages: Record<ContentSourceDenyReason, string> = {
  missing: "the ref is not valid or does not exist",
  private: "the ref is a private branch",
  fork: "the fork pull request has no preview:enabled label",
  closed: "the pull request was closed without a merge",
  unpublished: "the published branch does not contain the commit, and no allowed pull request has it as head",
}

function isAllowReason(reason: ContentSourceAllowReason | ContentSourceDenyReason): reason is ContentSourceAllowReason {
  return reason === "published" || reason === "pull" || reason === "label" || reason === "console" || reason === "token"
}

/** Whether an error is the nostics diagnostic `code`. */
function isDiagnostic(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code
}

/** The KV key of a head, such as `content:head:docs`. `vitehub kv get content:head:docs` shows it. */
function headKey(name: string): string {
  return `content:head:${name}`
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function"
}

function isGitHubDefinition(definition: Source<string, unknown, object> | undefined): definition is GitHubDefinition {
  return definition?.name === "github" && "authenticated" in definition && typeof definition.authenticated === "function"
}

/** The part of a ViteHub KV store that Content uses, such as `kv` from `@vite-hub/kv`. */
export interface ContentKV {
  get<T>(key: string): Promise<readonly [unknown, T | null | undefined]>
  set<T>(key: string, value: T): Promise<readonly [unknown, unknown]>
}

let installedKV: ContentKV | undefined
/**
 * The build that registered KV. Plugin options can live in closures that the parser hash cannot read, so each build
 * gets its own commit cache keys.
 */
let installedBuild: string | undefined

/** The `CONTENT_R0022` errors of KV calls. Reads fall back on these and throw every other error. */
const kvFailures = new WeakSet<object>()

type KVFailure = ReturnType<typeof contentErrorDiagnostics.CONTENT_R0022>

function isKVFailure(error: unknown): error is KVFailure {
  return error instanceof Error && kvFailures.has(error)
}

/**
 * Give Content the KV store that keeps the heads of `github()` Sources. When the app enables ViteHub KV, the build
 * calls it at the top of `server/content.ts`; you do not call it yourself. Without it, no Source is live.
 */
export function registerContentKV(store: ContentKV | undefined, build?: string): void {
  installedKV = store
  installedBuild = build
}

/** The head state of one Content runtime. */
interface ContentSourceHeadsRuntime {
  /** `content.sources`. */
  api: ContentSourceHeads
  /** Resolve selected heads before hub reads, including Comark's internal cache and index paths. */
  sync(names?: readonly string[]): Promise<void>
  /** How the instance of a `github()` Source reads its head commit, for `createContentInstance()`. Undefined for other Sources. */
  commits(name: string, input: ContentSourceInput): ContentSourceCommits | undefined
  /** Give a `github()` Source its Comark instance, so a moved head reloads it. */
  attach(name: string, instance: ComarkContent): void
  /** Close every view after its current reads finish. */
  dispose(): Promise<void>
}

/** Create the head state of a Content runtime. Reuse parsed KV documents only when the parser identity is known. */
export function createContentSourceHeads(options: ContentOptions, access: { privateBranches?: readonly string[] } = {}, reuseParsed: boolean = false): ContentSourceHeadsRuntime {
  const states = new Map<string, HeadState>()
  /** The commits that this server instance holds, by cache key. Each load shares one promise, so one download serves all. */
  const memory = new CommitMemory<Promise<LoadedCommit>>()
  // The cache, logger, and error mode do not change what a document parses to.
  const parser = { ...options, cache: undefined, logger: undefined, onError: undefined }
  /** The views of `at()`, by `<source>:<sha>`. The map order is the use order, the least recently used first. */
  const views = new Map<string, OpenView>()
  /** One namespace owner per Source/SHA, including evicted views while a read or cleanup still runs. */
  const allViews = new Map<string, OpenView>()
  let disposed = false
  /** The commits that refs resolved to, by `<source>:<ref>`, with when the lookup started. */
  const refs = new CommitMemory<{ at: number, target: Promise<ContentSourceRef> }>(MAX_HELD_REFS)
  /** Branches that only a preview cookie or a signed link opens, such as the CMS draft branch. */
  const privateBranches = new Set(access.privateBranches ?? [])
  /** The public rule decisions, by `<source>:<ref>:<sha>`, with when GitHub answered. */
  const decisions = new CommitMemory<{ at: number, reason: ContentSourceAllowReason | ContentSourceDenyReason }>(MAX_HELD_DECISIONS)

  function stateOf(name = "default"): HeadState {
    const state = states.get(name)
    if (state) return state
    throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content source ${JSON.stringify(name)} has no head. Only github() Sources have one. Sources with a head: ${[...states.keys()].join(", ") || "none"}.` })
  }

  function origin(state: HeadState): string {
    return JSON.stringify(state.definition.fingerprint ?? null)
  }

  async function isLive(state: HeadState): Promise<boolean> {
    state.live ??= state.definition.authenticated().then((authenticated) => {
      if (!authenticated) console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0020({ source: state.name })))
      else if (!installedKV) console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0021({ source: state.name })))
      return authenticated && Boolean(installedKV)
    })
    return await state.live
  }

  function kv(state: HeadState): ContentKV {
    if (installedKV) return installedKV
    throw contentErrorDiagnostics.CONTENT_R0021({ source: state.name })
  }

  /** Run one KV call. A failure, returned or thrown, becomes `CONTENT_R0022`, so reads can tell it from other errors. */
  async function kvCall<T>(state: HeadState, call: (store: ContentKV) => Promise<readonly [unknown, T]>): Promise<T> {
    const store = kv(state)
    let result: readonly [unknown, T]
    try {
      result = await call(store)
    }
    catch (error) {
      throw kvFailure(state, error)
    }
    if (result[0]) throw kvFailure(state, result[0])
    return result[1]
  }

  function kvFailure(state: HeadState, cause: unknown): KVFailure {
    const error = contentErrorDiagnostics.CONTENT_R0022({ source: state.name, key: headKey(state.name), reason: cause instanceof Error ? cause.message : String(cause) })
    kvFailures.add(error)
    return error
  }

  async function read(state: HeadState): Promise<StoredHead | null> {
    const stored = await kvCall(state, store => store.get<StoredHead>(headKey(state.name)))
    return stored && stored.origin === origin(state) ? stored : null
  }

  async function write(state: HeadState, head: StoredHead): Promise<void> {
    await kvCall(state, store => store.set(headKey(state.name), head))
  }

  /** Load and parse every document of `input`. Returns the documents, or the error when a document does not parse. */
  async function parse(name: string, input: ContentSourceInput): Promise<Omit<ContentCommit, "files"> | string> {
    // A fresh memory cache, so `snapshot()` reads the parsed documents back without loading the files again.
    const instance = createContentInstance(name, input, { ...options, cache: {}, logger: false, onError: "throw" })
    // Index plugins, such as `sql-query`, write their tables on `file:bulk:load`. A check must not change them.
    const { hooks } = instance
    const callHook = hooks.callHook
    hooks.callHook = ((hook: string, ...args: unknown[]) => hook === "file:bulk:load" ? Promise.resolve() : Reflect.apply(callHook, hooks, [hook, ...args])) as typeof callHook
    try {
      await instance.init({ partial: false, ignoreCache: true })
      const { items } = await instance.snapshot()
      return { manifest: await instance.manifest(), items }
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    finally {
      await instance.dispose()
    }
  }

  /** Parse the files of one commit. Returns the commit, or why it is invalid. */
  async function parseCommit(state: HeadState, files: LoadedCommit["files"]): Promise<LoadedCommit> {
    // The Source options, such as `prefix` and `schema`, change the parsed documents.
    const { prefix, schema } = contentSource(state.input)
    const parsed = await parse(state.name, contentSource({ items: async () => files }, { prefix, schema }))
    if (typeof parsed !== "string") return { files, commit: { files, ...parsed } }
    // Parse errors, such as YAML errors, do not name the document. Parse each document alone to find it.
    for (const item of files) {
      const single: Source<string, unknown, object> = { name: state.definition.name, getKeys: async () => [item.key], getItem: async () => item }
      const error = await parse(state.name, contentSource(single, { prefix, schema }))
      if (typeof error === "string") return { files, reason: `${item.path ?? item.key}: ${error}` }
    }
    return { files, reason: parsed }
  }

  function hashOf(state: HeadState): Promise<string> {
    const { prefix, schema } = contentSource(state.input)
    state.hash ??= parserHash({ parser, source: state.definition.fingerprint ?? null, prefix, schema, build: installedBuild ?? null })
    return state.hash
  }

  async function readCommit(key: string): Promise<ContentCommit | undefined> {
    const store = installedKV
    if (!store) return
    let result: readonly [unknown, CacheArtifact | null | undefined]
    // A KV store that throws counts as a miss, so the page still loads the commit from GitHub.
    try {
      result = await store.get<CacheArtifact>(key)
    }
    catch {
      return
    }
    const [error, artifact] = result
    if (error || !artifact) return
    try {
      return await decodeCommit(artifact)
    }
    // An entry that does not decode, such as one cut short, counts as a miss. The next valid load writes it again.
    catch {}
  }

  async function writeCommit(state: HeadState, key: string, commit: ContentCommit): Promise<void> {
    const store = installedKV
    if (!store) return
    let failure: unknown
    try {
      [failure] = await store.set(key, await encodeCommit(state.name, commit))
    }
    catch (error) {
      failure = error
    }
    if (failure) console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0023({ source: state.name, key, reason: failure instanceof Error ? failure.message : String(failure) })))
  }

  /**
   * One commit of a Source: from memory, then from ViteHub KV, then from its GitHub archive. Only a commit whose documents
   * all parse goes to KV. Concurrent loads of one commit share one download.
   */
  async function load(state: HeadState, revision: SourceRevision): Promise<LoadedCommit> {
    const key = commitKey(await hashOf(state), revision.id, state.name)
    const held = memory.get(key)
    if (held) {
      state.stats.memory++
      return await held
    }
    const loading = (async (): Promise<LoadedCommit> => {
      const stored = await readCommit(key)
      if (stored) {
        state.stats.kv++
        // Function text cannot identify a custom plugin's captured options. Only its immutable raw files are reusable.
        return reuseParsed ? { files: stored.files, commit: stored } : await parseCommit(state, stored.files)
      }
      state.stats.misses++
      const loaded = await parseCommit(state, await createSource(state.definition, { revision }).items())
      if (loaded.commit) await writeCommit(state, key, loaded.commit)
      return loaded
    })()
    memory.set(key, loading)
    // A failed download or a rejected commit leaves no entry, so `advance()` can retry the same SHA.
    const forget = () => {
      if (memory.get(key) === loading) memory.delete(key)
    }
    loading.then(loaded => loaded.reason && forget(), forget)
    return await loading
  }

  /**
   * Load and parse every document of one commit. Returns why the commit is invalid, or undefined when it is valid.
   * This is the seam for `vitehub content check`, which adds schema, link, and SEO checks.
   */
  async function check(state: HeadState, revision: SourceRevision): Promise<string | undefined> {
    // A commit that does not download, such as on a network failure, is rejected too. `advance()` retries it.
    try {
      return (await load(state, revision)).reason
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Move the head to the latest valid commit of the branch, and return the stored head. */
  async function move(state: HeadState): Promise<StoredHead | null> {
    const before = await read(state)
    if (before?.pinned) return before
    // A fresh reader resolves the branch, not the head that the instance reads.
    const revision = await createSource(state.definition).revision()
    // Without an immutable commit, such as when GitHub rate limits the lookup, the head stays where it is.
    if (!revision?.immutable || revision.id === before?.sha) return before
    const reason = await check(state, revision)
    const now = new Date().toISOString()
    const next: StoredHead = reason
      ? { ...(before ?? { origin: origin(state), sha: null, ref: revision.ref ?? null, movedAt: null, pinned: false }), rejected: { sha: revision.id, at: now, reason } }
      : { origin: origin(state), sha: revision.id, ref: revision.ref ?? null, movedAt: now, pinned: false, rejected: null }
    // Best-effort conflict detection only. KV is not CAS: callers must serialize initialization and mutations through one writer.
    const latest = await read(state)
    if (JSON.stringify(latest) !== JSON.stringify(before)) return latest
    await write(state, next)
    return next
  }

  function hold(state: HeadState, head: StoredHead | null): void {
    state.held = { head, at: Date.now() }
    if (!head?.rejected || state.reported.has(head.rejected.sha)) return
    state.reported.add(head.rejected.sha)
    console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha: head.rejected.sha, reason: head.rejected.reason, head: head.sha })))
  }

  /** The head held in memory, or read from KV. The first read of a Source without a stored head resolves one. */
  async function current(state: HeadState): Promise<StoredHead | null> {
    if (state.held && Date.now() - state.held.at < HOLD_MS) return state.held.head
    state.reading ??= (async () => {
      const head = await read(state) ?? await move(state)
      hold(state, head)
      return head
    })().finally(() => {
      state.reading = undefined
    })
    return await state.reading
  }

  /** Point readers at the selected head; only mark a reload complete after it succeeds. */
  async function serve(state: HeadState, head: StoredHead | null): Promise<void> {
    if (state.refreshing) await state.refreshing
    if (!head?.sha) return
    const selected = { sha: head.sha, ref: head.ref }
    const instance = state.instance
    const previous = state.served
    state.served = selected
    if (!instance || instance.status === "created" || instance.status === "disposed" || state.loaded === head.sha) return
    const refreshing = state.access.run(true, async () => {
      try {
        // Comark keeps its old index when a refresh cannot load the commit. Load it first, so a failed download fails here.
        await load(state, { id: selected.sha, immutable: true, ...(selected.ref ? { ref: selected.ref } : {}) })
        await instance.refresh()
        state.loaded = selected.sha
      }
      catch (error) {
        state.served = previous
        throw error
      }
    })
    state.refreshing = refreshing
    try {
      await refreshing
    }
    finally {
      if (state.refreshing === refreshing) state.refreshing = undefined
    }
  }

  /**
   * What a read serves when KV fails: the commit that this server instance already serves, which passed validation,
   * or else no head, so the Source reads the latest commit of its branch as it does without KV.
   */
  function fallback(state: HeadState): StoredHead | null {
    return state.served ? { origin: origin(state), sha: state.served.sha, ref: state.served.ref, movedAt: null, pinned: false, rejected: null } : null
  }

  function kvFailing(state: HeadState): boolean {
    return state.failed !== undefined && Date.now() - state.failed < HOLD_MS
  }

  async function view(state: HeadState, head: StoredHead | null, live = true): Promise<ContentSourceHead> {
    const { memory: memoryHits, kv: kvHits, misses } = state.stats
    return {
      source: state.name,
      live,
      sha: head?.sha ?? null,
      ref: head?.ref ?? null,
      movedAt: head?.movedAt ?? null,
      pinned: head?.pinned ?? false,
      rejected: head?.rejected ?? null,
      cache: { key: live && head?.sha ? commitKey(await hashOf(state), head.sha, state.name) : null, hits: { memory: memoryHits, kv: kvHits }, misses },
      views: [...views.values()].filter(open => open.state === state).map(open => open.sha),
    }
  }

  /** The commit that a ref points to. A SHA lookup holds until it leaves memory, a branch or pull request for 30 seconds. */
  async function resolveRef(state: HeadState, parsed: ParsedContentRef): Promise<ContentSourceRef> {
    const key = `${state.name}:${parsed.ref}`
    const held = refs.get(key)
    if (held && (parsed.kind === "commit" || Date.now() - held.at < REF_HOLD_MS)) return await held.target
    const target = (async (): Promise<ContentSourceRef> => {
      const resolve = state.definition.resolveRef
      if (!resolve) throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content source ${JSON.stringify(state.name)} cannot open refs. Update @vite-hub/source.` })
      let resolved: GitHubRefTarget | undefined
      try {
        resolved = await resolve.call(state.definition, parsed.lookup)
      }
      catch (error) {
        throw contentErrorDiagnostics.CONTENT_R0029({ source: state.name, ref: parsed.ref, reason: error instanceof Error ? error.message : String(error), cause: error })
      }
      if (!resolved) throw contentErrorDiagnostics.CONTENT_R0028({ source: state.name, ref: parsed.ref })
      return { source: state.name, ref: parsed.ref, kind: parsed.kind, sha: resolved.sha.toLowerCase(), pull: resolved.pull ?? null }
    })()
    refs.set(key, { at: Date.now(), target })
    // A failed lookup is not held, so the next call asks GitHub again.
    target.catch(() => {
      if (refs.get(key)?.target === target) refs.delete(key)
    })
    return await target
  }

  function close(open: OpenView): Promise<void> {
    return open.closing ??= (async () => {
      try {
        if (open.readers) await new Promise<void>((resolve) => { open.idle = resolve })
        // `dispose()` keeps the SQL and search rows of a ref in a shared database. `clean()` drops them, then disposes.
        if (open.view.status !== "disposed") await open.view.clean()
        await Promise.all([open.hub.dispose(), ...open.instances.map(instance => instance.dispose())])
      }
      finally {
        allViews.delete(open.key)
      }
    })()
  }

  function assertActive(): void {
    if (disposed) throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content source views have been disposed." })
  }

  /** The open view of one commit. Opening a view past the bound closes the least recently used one. */
  async function openView(state: HeadState, sha: string, acquire = false): Promise<OpenView> {
    assertActive()
    const key = `${state.name}:${sha}`
    let open = allViews.get(key)
    // Cleanup owns this namespace until it finishes. Concurrent waiters check the owner again after each wait.
    while (open?.closing) {
      await open.closing
      assertActive()
      open = allViews.get(key)
    }
    if (!open) {
      const revision: SourceRevision = { id: sha, immutable: true }
      const commits: ContentSourceCommits = {
        revision: async () => revision,
        files: async commit => (await load(state, commit)).files,
        documents: origin => withCommitDocuments(origin, async () => (await load(state, revision)).commit),
      }
      const base = createContentInstance(state.name, state.input, options, undefined, commits)
      // A ref instance keeps its cache entries and plugin tables apart from the head instance of the same Source.
      const instance = base.withRef(sha)
      open = { key, state, sha, instances: [base], view: instance, hub: contentHub<ComarkContent[]>([instance], { basePath: options.basePath ?? "/api/content", logger: options.logger }), readers: 0, evicted: false }
      allViews.set(key, open)
    }
    // An evicted view with active readers can rejoin the pool without creating another owner of its namespace.
    open.evicted = false
    views.delete(key)
    views.set(key, open)
    // Reserve the reader before yielding, so eviction cannot close the view between acquisition and use.
    if (acquire) open.readers++
    while (views.size > MAX_SOURCE_VIEWS) {
      const [oldest] = views.values()
      views.delete(oldest!.key)
      oldest!.evicted = true
      // An eviction has no caller to report cleanup errors to.
      if (!oldest!.readers) void close(oldest!).catch(() => {})
    }
    return open
  }

  /** Run one read on the view of a commit. A view that left the pool opens again, from the commit cache. */
  async function readAt<T>(state: HeadState, sha: string, read: (hub: ContentHub<ComarkContent[]>) => Promise<T>): Promise<T> {
    const open = await openView(state, sha, true)
    try {
      return await read(open.hub)
    }
    finally {
      open.readers--
      if (!open.readers) {
        open.idle?.()
        if (open.evicted) void close(open).catch(() => {})
      }
    }
  }

  /** A ref that a caller passed back from `allow()` or a view. Only its SHA and ref shape are checked. */
  function givenRef(ref: ContentSourceRef): ContentSourceRef {
    const parsed = parseContentRef(ref.ref)
    if (typeof ref.sha !== "string" || !fullSha.test(ref.sha) || parsed.kind !== ref.kind) {
      throw contentErrorDiagnostics.CONTENT_R0027({ ref: parsed.ref, reason: "pass the target of content.sources.allow() or a view, with a full commit SHA" })
    }
    return { source: ref.source, ref: parsed.ref, kind: ref.kind, sha: ref.sha.toLowerCase(), pull: ref.pull ?? null }
  }

  /** The GitHub facts of the public rule for one commit. A failed request becomes `CONTENT_R0032` and holds no decision. */
  function publicFacts(state: HeadState, target: ContentSourceRef) {
    const ask = async <T>(read: (() => Promise<T>) | undefined): Promise<T> => {
      if (!read) throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content source ${JSON.stringify(state.name)} cannot check refs. Update @vite-hub/source.` })
      try {
        return await read()
      }
      catch (error) {
        throw contentErrorDiagnostics.CONTENT_R0032({ source: state.name, ref: target.ref, reason: error instanceof Error ? error.message : String(error), cause: error })
      }
    }
    const { definition } = state
    const { contains, pullsAt } = definition
    return {
      published: () => ask(contains && (() => contains.call(definition, target.sha))),
      pulls: () => ask(pullsAt && (() => pullsAt.call(definition, target.sha))),
    }
  }

  /** Resolve the head before a serving operation, including reads satisfied by a parsed index. */
  async function sync(state: HeadState): Promise<void> {
    if (!await isLive(state)) return
    if (kvFailing(state)) return await serve(state, fallback(state))
    let head: StoredHead | null
    try {
      head = await current(state)
    }
    catch (error) {
      if (!isKVFailure(error)) throw error
      if (!kvFailing(state)) {
        state.failed = Date.now()
        console.warn(formatDiagnostic(error))
      }
      return await serve(state, fallback(state))
    }
    state.failed = undefined
    if (!head?.sha) {
      if (head?.rejected) throw contentErrorDiagnostics.CONTENT_R0019({ source: state.name, ...head.rejected, head: null })
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content source ${JSON.stringify(state.name)} has no validated head. Resolve its GitHub commit, then call content.sources.advance().` })
    }
    await serve(state, head)
  }

  const api: ContentSourceHeads = {
    async head(source) {
      const state = stateOf(source)
      if (!await isLive(state)) return await view(state, null, false)
      const head = await current(state)
      await serve(state, head)
      return await view(state, head)
    },
    async advance(source) {
      const state = stateOf(source)
      if (!await isLive(state)) return await view(state, null, false)
      const head = await move(state)
      hold(state, head)
      await serve(state, head)
      return await view(state, head)
    },
    async pin(sha, source) {
      const state = stateOf(source)
      if (typeof sha !== "string" || !fullSha.test(sha)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.sources.pin() needs a full 40-character commit SHA, received ${JSON.stringify(sha)}.` })
      }
      if (!await isLive(state)) throw installedKV ? contentErrorDiagnostics.CONTENT_R0020({ source: state.name }) : contentErrorDiagnostics.CONTENT_R0021({ source: state.name })
      const before = await read(state)
      const reason = await check(state, { id: sha, immutable: true, ...(before?.ref ? { ref: before.ref } : {}) })
      if (reason) throw contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha, reason, head: before?.sha ?? null })
      const head: StoredHead = { origin: origin(state), sha, ref: before?.ref ?? null, movedAt: new Date().toISOString(), pinned: true, rejected: before?.rejected ?? null }
      await write(state, head)
      hold(state, head)
      await serve(state, head)
      return await view(state, head)
    },
    async unpin(source) {
      const state = stateOf(source)
      if (!await isLive(state)) return await view(state, null, false)
      const before = await read(state)
      if (before?.pinned) await write(state, { ...before, pinned: false })
      return await api.advance(source)
    },
    async at(ref, source) {
      assertActive()
      const state = stateOf(typeof ref === "object" && ref ? ref.source : source)
      const target = typeof ref === "object" && ref ? givenRef(ref) : await resolveRef(state, parseContentRef(ref))
      const loaded = await load(state, { id: target.sha, immutable: true })
      if (!loaded.commit) throw contentErrorDiagnostics.CONTENT_R0030({ source: state.name, ref: target.ref, sha: target.sha, reason: loaded.reason ?? "the commit has no documents" })
      await openView(state, target.sha)
      const read = <T>(run: (hub: ContentHub<ComarkContent[]>) => Promise<T>) => readAt(state, target.sha, run)
      return {
        ...target,
        // SAFETY: Each wrapper forwards its arguments unchanged, so the generic result types of the hub hold.
        get: ((key: string, opts?: Parameters<ContentHub["get"]>[1]) => read(hub => hub.get(key, opts))) as ContentHub["get"],
        list: ((names?: string[]) => read(hub => hub.list(names))) as ContentHub["list"],
        navigation: (names?: Parameters<ContentHub["navigation"]>[0]) => read(hub => hub.navigation(names)),
        search: (query: string, opts?: Parameters<ContentHub["search"]>[1]) => read(hub => hub.search(query, opts)),
      }
    },
    async allow(ref, request, source) {
      const state = stateOf(typeof ref === "object" && ref ? ref.source : source)
      const shown = typeof ref === "object" && ref ? ref.ref : String(ref).slice(0, 200)
      const deny = (reason: ContentSourceDenyReason, target?: ContentSourceRef): ContentSourceAccess => ({
        allowed: false,
        reason,
        error: contentErrorDiagnostics.CONTENT_R0031({ source: state.name, ref: target?.ref ?? shown, reason: denyMessages[reason] }),
      })
      let target: ContentSourceRef
      try {
        target = typeof ref === "object" && ref ? givenRef(ref) : await resolveRef(state, parseContentRef(ref))
      }
      catch (error) {
        if (isDiagnostic(error, "CONTENT_R0027") || isDiagnostic(error, "CONTENT_R0028")) return deny("missing")
        throw error
      }
      const grant = await contentRefGrant(request, state.name, target.ref)
      if (grant) return { allowed: true, reason: grant, target }
      const key = `${state.name}:${target.ref}:${target.sha}`
      const held = decisions.get(key)
      let reason = held && Date.now() - held.at < ACCESS_HOLD_MS ? held.reason : undefined
      if (!reason) {
        // A target or view that a caller kept holds the pull request as it was. The rule reads it from GitHub again, so a
        // removed label or a closed pull request counts. The pull request makes this commit public only while it is its head.
        let facts = target
        if (target.kind === "pull" && typeof ref === "object") {
          try {
            const current = await resolveRef(state, parseContentRef(target.ref))
            facts = { ...target, pull: current.sha === target.sha ? current.pull : null }
          }
          catch (error) {
            if (isDiagnostic(error, "CONTENT_R0028")) return deny("missing", target)
            throw error
          }
        }
        if (isPrivateRef(facts, privateBranches)) return deny("private", target)
        reason = await publicRule(facts, publicFacts(state, facts), privateBranches)
        decisions.set(key, { at: Date.now(), reason })
      }
      else if (isPrivateRef(target, privateBranches)) return deny("private", target)
      return isAllowReason(reason) ? { allowed: true, reason, target } : deny(reason, target)
    },
    async sign(ref, source, signOptions) {
      const state = stateOf(source)
      return await signContentRefToken(state.name, parseContentRef(ref).ref, signOptions?.maxAge)
    },
  }

  return {
    api,
    async dispose() {
      disposed = true
      views.clear()
      await Promise.all([...allViews.values()].map(close))
    },
    async sync(names) {
      await Promise.all([...states.values()].filter(state => names === undefined || names.includes(state.name)).map(state => sync(state)))
    },
    commits(name: string, input: ContentSourceInput): ContentSourceCommits | undefined {
      const definition = contentSourceDefinition(input)
      if (!isGitHubDefinition(definition)) return
      const state: HeadState = { name, input, definition, reported: new Set(), stats: { memory: 0, kv: 0, misses: 0 }, access: new AsyncLocalStorage() }
      states.set(name, state)
      // A read outside a guarded operation first brings the Source to its head.
      const revision = async (): Promise<SourceRevision | undefined> => {
        if (!state.access.getStore()) await state.access.run(true, () => sync(state))
        return state.served ? { id: state.served.sha, immutable: true, ...(state.served.ref ? { ref: state.served.ref } : {}) } : undefined
      }
      return {
        revision,
        files: async commit => (await load(state, commit)).files,
        documents: origin => withCommitDocuments(origin, async () => {
          const served = await revision()
          return served && (await load(state, served)).commit
        }),
      }
    },
    attach(name: string, instance: ComarkContent): void {
      const state = states.get(name)
      if (!state) return
      state.instance = instance
      const guard = (method: (...args: unknown[]) => unknown, target: object, initialize = false) => {
        return (...args: unknown[]) => state.access.getStore()
          ? Reflect.apply(method, target, args)
          : state.access.run(true, async () => {
              await sync(state)
              if (initialize) await instance.init()
              const result: unknown = await Reflect.apply(method, target, args)
              if (instance.status === "initialized-full" || instance.status === "initialized-partial") state.loaded = state.served?.sha
              return result
            })
      }
      // Guard direct instance reads too. The hub boundary covers its internal cache/index paths that skip these methods.
      // Nested init/get calls and the serving reload bypass this guard.
      for (const key of ["init", "get", "refresh", "list", "navigation", "manifest", "snapshot", "handler", "search"]) {
        const method: unknown = Reflect.get(instance, key)
        if (isFunction(method)) Object.defineProperty(instance, key, { value: guard(method, instance, key === "search") })
      }
      // SQL query builders stay synchronous. Only their terminal operations resolve the selected head.
      const query: unknown = Reflect.get(instance, "query")
      if (typeof query === "function") Object.defineProperty(instance, "query", {
        value(...args: unknown[]) {
          const builder: object = Reflect.apply(query, instance, args)
          for (const key of ["all", "first", "count"]) {
            const method: unknown = Reflect.get(builder, key)
            if (isFunction(method)) Object.defineProperty(builder, key, { value: guard(method, builder, true) })
          }
          return builder
        },
      })
    },
  }
}
