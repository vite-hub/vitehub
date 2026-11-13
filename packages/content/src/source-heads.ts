import { AsyncLocalStorage } from "node:async_hooks"

import { createSource } from "@vite-hub/source"
import type { GitHubRefTarget, GitHubSource, Source, SourceItem, SourceRevision } from "@vite-hub/source"
import { contentHub } from "comark-content"
import type { CacheArtifact, ComarkContent, ContentHub, ContentOptions } from "comark-content"
import { formatDiagnostic } from "nostics"
import type { Diagnostic } from "nostics"

import { CommitMemory, commitJson, commitKey, decodeCommit, encodeCommit, parserHash, readCommitJson, withCommitDocuments } from "./commit-cache.ts"
import { contentSource, contentSourceDefinition, createContentInstance } from "./content-source.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentKV, contentKVBuild } from "./kv.ts"
import { contentRefGrant, signContentRefToken } from "./preview.ts"
import { ACCESS_HOLD_MS, isPrivateRef, publicRule } from "./source-access.ts"
import { openCommitSnapshot } from "./snapshots.ts"
import { parseContentRef } from "./source-refs.ts"

import type { ContentCommit, ContentCommitCacheStats } from "./commit-cache.ts"
import type { ContentKV } from "./kv.ts"
import type { ContentSourceCommits, ContentSourceInput } from "./content-source.ts"
import type { ContentPreviewOptions, ContentPreviewToken } from "./preview.ts"
import type { BuiltContentCommit, ContentCommitSnapshot, ContentSnapshotLoader } from "./snapshots.ts"
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
  /** The newest commit that failed validation, and why. May remain as history after recovery; `diagnostic` says whether it still blocks the head. */
  rejected: { sha: string, at: string, reason: string } | null
  /** When Content last resolved the branch, as an ISO date. Content resolves it again after one hour without a push. */
  checkedAt: string | null
  /** The last GitHub push webhook delivery for this Source, or null when none arrived. */
  webhook: ContentSourceWebhookDelivery | null
  /**
   * Why the head does not follow the branch, with its fix: `CONTENT_R0020` (no token), `CONTENT_R0021` (no KV store),
   * `CONTENT_R0035` (GitHub refused the last branch lookup of this server instance), or `CONTENT_R0019` (the newest
   * commit failed validation). Null when the head follows the branch. `vitehub content head` prints it.
   */
  diagnostic: ContentSourceHeadDiagnostic | null
  /** How this server instance read commits of the Source: from memory, from ViteHub KV, or from a GitHub archive. */
  cache: ContentCommitCacheStats
  /** The commits of the Source that this server instance holds open for `at()`, the most recently used last. */
  views: string[]
}

/** A diagnostic of a head, as `head()` returns it. `vitehub content head --json` prints the same fields. */
export interface ContentSourceHeadDiagnostic {
  code: "CONTENT_R0019" | "CONTENT_R0020" | "CONTENT_R0021" | "CONTENT_R0035"
  message: string
  fix: string
}

/** One GitHub push webhook delivery that matched a Source. */
export interface ContentSourceWebhookDelivery {
  /** The `X-GitHub-Delivery` id. GitHub shows it under Recent Deliveries. */
  id: string | null
  /** When Content received the delivery, as an ISO date. */
  at: string
  /** The commit that the push names in `after`. */
  sha: string | null
  /**
   * What `advance()` did: `moved` to a new commit, `kept` the same head, `rejected` the pushed commit because a document
   * did not parse, kept a `pinned` head, or `failed` with `error`.
   */
  result: "failed" | "kept" | "moved" | "pinned" | "rejected"
  /** The error of a `failed` delivery. */
  error?: string
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
export type GitHubDefinition = Source<string, unknown, object> & Pick<GitHubSource, "authenticated"> & Partial<Pick<GitHubSource, "history" | "latest" | "changes" | "resolveRef" | "contains" | "pullsAt">>

/** The KV value of a head. */
interface StoredHead {
  /** The Source fingerprint the head belongs to. A head of another repository or ref is ignored. */
  origin: string
  sha: string | null
  ref: string | null
  movedAt: string | null
  pinned: boolean
  rejected: ContentSourceHead["rejected"]
  /** True after a valid pin or a lookup confirms the serving commit. Older heads infer recovery from `movedAt`. */
  rejectionResolved?: boolean
  /** The check time in heads stored before polling metadata moved to its own key. */
  checkedAt?: string | null
}

/** The last completed branch check, separate from both head authority and the short check lease. */
interface StoredCheck {
  origin: string
  at: string
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
  stats: { memory: number, build: number, kv: number, misses: number }
  /** The build snapshot of the Source, opened on the first commit load. */
  built?: () => Promise<ContentCommitSnapshot | undefined>
  instance?: ComarkContent
  /** Whether the Source has a token and the app a KV store. Checked once per server instance. */
  live?: Promise<boolean>
  /** `CONTENT_R0020` or `CONTENT_R0021` when the Source is not live. */
  offline?: ContentSourceHeadDiagnostic
  /** `CONTENT_R0035` when the last branch lookup of this server instance got no commit from GitHub. */
  limited?: ContentSourceHeadDiagnostic
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
/** How long a head waits for a push before a read resolves the branch again. A push webhook moves it sooner. */
const CHECK_MS = 60 * 60 * 1000
/** How long the lease of an hourly check holds off the checks of other server instances. */
const CHECK_LEASE_MS = 60_000
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

/** The KV key of the lease of the hourly check of a Source, such as `content:check:docs`. */
function checkKey(name: string): string {
  return `content:check:${name}`
}

/** The KV key of the last completed branch check, such as `content:checked:docs`. */
function checkedKey(name: string): string {
  return `content:checked:${name}`
}

/** The KV key of the last push webhook delivery of a Source, such as `content:webhook:docs`. */
function webhookKey(name: string): string {
  return `content:webhook:${name}`
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function"
}

function isGitHubDefinition(definition: Source<string, unknown, object> | undefined): definition is GitHubDefinition {
  return definition?.name === "github" && "authenticated" in definition && typeof definition.authenticated === "function"
}

/** The `CONTENT_R0022` errors of KV calls. Reads fall back on these and throw every other error. */
const kvFailures = new WeakSet<object>()

type KVFailure = ReturnType<typeof contentErrorDiagnostics.CONTENT_R0022>

/** The fields of a diagnostic that `head()` returns. `warn` also logs it. */
function diagnosticOf(code: ContentSourceHeadDiagnostic["code"], error: Diagnostic<unknown>, warn = false): ContentSourceHeadDiagnostic {
  if (warn) console.warn(formatDiagnostic(error))
  return { code, message: error.message, fix: error.fix ?? "" }
}

function isKVFailure(error: unknown): error is KVFailure {
  return error instanceof Error && kvFailures.has(error)
}

/** The head state of one Content runtime. */
interface ContentSourceHeadsRuntime {
  /** `content.sources`. */
  api: ContentSourceHeads
  /** Resolve selected heads before hub reads, including Comark's internal cache and index paths. */
  sync(names?: readonly string[]): Promise<void>
  /**
   * How the instance of a `github()` Source reads its head commit, for `createContentInstance()`. Undefined for other
   * Sources. `snapshot` is the build snapshot of the Source, which serves the commit that the build parsed.
   */
  commits(name: string, input: ContentSourceInput, snapshot?: ContentSnapshotLoader): ContentSourceCommits | undefined
  /** For the build: resolve and parse the branch commit of a `github()` Source. Undefined without a GitHub token. */
  snapshot(name: string): Promise<BuiltContentCommit | string | undefined>
  /** Give a `github()` Source its Comark instance, so a moved head reloads it. */
  attach(name: string, instance: ComarkContent): void
  /** Close every view after its current reads finish. */
  dispose(): Promise<void>
  /** The `github()` definition of a Source, or undefined for other Sources. */
  github(name: string): GitHubDefinition | undefined
  /**
   * The commit that readers get from a `github()` Source: its head, else the commit that this server instance serves
   * when KV fails, else the latest commit of its branch. Null when GitHub gives no immutable commit.
   */
  published(name: string): Promise<string | null>
  /** The names of the `github()` Sources. */
  names(): string[]
  /** The names of the `github()` Sources that follow `ref` of `repo`. `defaultBranch` resolves a Source without `ref`. */
  match(repo: string, ref: string, defaultBranch: string | undefined): { repository: boolean, sources: string[] }
  /**
   * Run a read with the Comark instance of the commit of a ref, for a preview request. The commit must pass validation,
   * as for `at()`. The view stays open until the read ends.
   */
  read<T>(target: ContentSourceRef, read: (view: ComarkContent) => Promise<T>): Promise<T>
  /** Advance a Source for a push webhook delivery and keep the delivery in KV, where `head()` shows it. */
  deliver(source: string, delivery: { id: string | null, sha: string | null }): Promise<ContentSourceWebhookDelivery>
  /** Run `work` after the push webhook moves the head of a Source, such as computing page dates. */
  onMove(work: (source: string) => Promise<void>): void
  /** The work of `onMove()` for a Source whose head moved. The push webhook runs it in `waitUntil`. */
  moved(source: string): Promise<void>
}

const runtimes = new WeakMap<object, ContentSourceHeadsRuntime>()

/** The runtime behind `content.sources`, for the push webhook route and the Content operations. */
export function contentSourceHeadsRuntime(api: object): ContentSourceHeadsRuntime | undefined {
  return runtimes.get(api)
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
      if (!authenticated) state.offline = diagnosticOf("CONTENT_R0020", contentErrorDiagnostics.CONTENT_R0020({ source: state.name }), true)
      else if (!contentKV()) state.offline = diagnosticOf("CONTENT_R0021", contentErrorDiagnostics.CONTENT_R0021({ source: state.name }), true)
      return !state.offline
    })
    return await state.live
  }

  function kv(state: HeadState): ContentKV {
    const store = contentKV()
    if (store) return store
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

  async function lastCheck(state: HeadState, head: StoredHead): Promise<string | null> {
    const stored = await kvCall(state, store => store.get<StoredCheck>(checkedKey(state.name)))
    const at = head.checkedAt ?? head.movedAt
    return stored?.origin === origin(state) && Date.parse(stored.at) >= (Date.parse(at ?? "") || 0) ? stored.at : at ?? null
  }

  async function checked(state: HeadState): Promise<void> {
    await kvCall(state, store => store.set(checkedKey(state.name), { origin: origin(state), at: new Date().toISOString() }))
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
    state.hash ??= parserHash({ parser, source: state.definition.fingerprint ?? null, prefix, schema, build: contentKVBuild() ?? null })
    return state.hash
  }

  /** The commit `sha` from the build snapshot, or undefined when the build parsed another commit or none. */
  async function readBuilt(state: HeadState, sha: string): Promise<ContentCommit | undefined> {
    if (!state.built) return
    // A snapshot that does not load or inflate counts as a miss, like a KV entry that does not decode.
    try {
      const snapshot = await state.built()
      if (snapshot?.sha !== sha || snapshot.origin !== origin(state)) return
      return readCommitJson(await snapshot.read())
    }
    catch {}
  }

  async function readCommit(key: string): Promise<ContentCommit | undefined> {
    const store = contentKV()
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
    const store = contentKV()
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
   * One commit of a Source: from memory, then from the build snapshot, then from ViteHub KV, then from its GitHub archive.
   * Only a commit whose documents all parse goes to KV. Concurrent loads of one commit share one download. The build
   * snapshot does not go to KV: each server instance of the build has it.
   */
  async function load(state: HeadState, revision: SourceRevision): Promise<LoadedCommit> {
    const key = commitKey(await hashOf(state), revision.id, state.name)
    const held = memory.get(key)
    if (held) {
      state.stats.memory++
      return await held
    }
    const loading = (async (): Promise<LoadedCommit> => {
      const built = await readBuilt(state, revision.id)
      if (built) {
        state.stats.build++
        return { files: built.files, commit: built }
      }
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

  /** Move the head to the latest valid commit of the branch, and record a completed check separately. */
  async function move(state: HeadState, recheck = false): Promise<StoredHead | null> {
    const before = await read(state)
    if (before?.pinned) return before
    // A fresh reader resolves the branch, not the head that the instance reads.
    const revision = await createSource(state.definition).revision()
    // Without an immutable commit, such as when GitHub rate limits the lookup, the head stays where it is.
    if (!revision?.immutable) {
      // Log once until a lookup succeeds again.
      state.limited ??= diagnosticOf("CONTENT_R0035", contentErrorDiagnostics.CONTENT_R0035({ source: state.name, head: before?.sha ?? null }), true)
      return before
    }
    state.limited = undefined
    if (revision.id === before?.sha) {
      const latest = await read(state)
      if (!before || JSON.stringify(latest) !== JSON.stringify(before)) return latest
      if (activeRejection(before)) await write(state, { ...before, rejectionResolved: true })
      else if (!recheck) return latest
      await checked(state)
      // A pin or webhook may have completed during the branch lookup. A check never restores the old head.
      return await read(state)
    }
    const reason = await check(state, revision)
    const now = new Date().toISOString()
    const next: StoredHead = reason
      ? { ...(before ?? { origin: origin(state), sha: null, ref: revision.ref ?? null, movedAt: null, pinned: false }), rejected: { sha: revision.id, at: now, reason }, rejectionResolved: false }
      : { origin: origin(state), sha: revision.id, ref: revision.ref ?? null, movedAt: now, pinned: false, rejected: null }
    // Best-effort conflict detection only. KV is not CAS: callers must serialize initialization and mutations through one writer.
    const latest = await read(state)
    if (JSON.stringify(latest) !== JSON.stringify(before)) return latest
    await write(state, next)
    await checked(state)
    return next
  }

  function hold(state: HeadState, head: StoredHead | null): void {
    state.held = { head, at: Date.now() }
    const rejected = activeRejection(head)
    if (!rejected || state.reported.has(rejected.sha)) return
    state.reported.add(rejected.sha)
    console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha: rejected.sha, reason: rejected.reason, head: head?.sha ?? null })))
  }

  /**
   * The head without a push for one hour resolves its branch again, so it moves without a webhook too. The server
   * instance that reads it first takes a one-minute lease under another KV key, so other server instances do not check
   * too. A separate completion key stores `checkedAt`, so a check-only write cannot replace head authority or write the
   * lease key twice within the provider's one-second limit. A failed check is tried again after the lease.
   */
  async function recheck(state: HeadState, head: StoredHead): Promise<StoredHead | null> {
    if (head.pinned) return head
    const checkedAt = Date.parse(await lastCheck(state, head) ?? "")
    if (Date.now() - (Number.isNaN(checkedAt) ? 0 : checkedAt) < CHECK_MS) return head
    const lease = await kvCall(state, store => store.get<{ at: number }>(checkKey(state.name)))
    if (lease && Date.now() - lease.at < CHECK_LEASE_MS) return head
    await kvCall(state, store => store.set(checkKey(state.name), { at: Date.now() }))
    return await move(state, true)
  }

  /** The head held in memory, or read from KV. The first read of a Source without a stored head resolves one. */
  async function current(state: HeadState): Promise<StoredHead | null> {
    if (state.held && Date.now() - state.held.at < HOLD_MS) return state.held.head
    state.reading ??= (async () => {
      const stored = await read(state)
      const head = stored ? await recheck(state, stored) : await move(state)
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

  async function lastDelivery(state: HeadState): Promise<ContentSourceWebhookDelivery | null> {
    const store = contentKV()
    if (!store) return null
    const [error, delivery] = await store.get<ContentSourceWebhookDelivery>(webhookKey(state.name))
    if (error) throw error
    return delivery ?? null
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
    const { memory: memoryHits, build: buildHits, kv: kvHits, misses } = state.stats
    return {
      source: state.name,
      live,
      sha: head?.sha ?? null,
      ref: head?.ref ?? null,
      movedAt: head?.movedAt ?? null,
      pinned: head?.pinned ?? false,
      rejected: head?.rejected ?? null,
      checkedAt: live && head ? await lastCheck(state, head) : null,
      webhook: await lastDelivery(state),
      diagnostic: diagnostic(state, head, live),
      cache: { key: live && head?.sha ? commitKey(await hashOf(state), head.sha, state.name) : null, hits: { memory: memoryHits, build: buildHits, kv: kvHits }, misses },
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
  async function readAt<T>(state: HeadState, sha: string, read: (hub: ContentHub<ComarkContent[]>, view: ComarkContent) => Promise<T>): Promise<T> {
    const open = await openView(state, sha, true)
    try {
      return await read(open.hub, open.view)
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

  function activeRejection(head: StoredHead | null): ContentSourceHead["rejected"] {
    if (!head?.rejected) return null
    const resolved = head.rejectionResolved ?? Boolean(head.movedAt && head.rejected.at < head.movedAt)
    return resolved ? null : head.rejected
  }

  function diagnostic(state: HeadState, head: StoredHead | null, live: boolean): ContentSourceHeadDiagnostic | null {
    if (!live) return state.offline ?? null
    if (state.limited) return state.limited
    const rejected = activeRejection(head)
    if (rejected) return diagnosticOf("CONTENT_R0019", contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha: rejected.sha, reason: rejected.reason, head: head?.sha ?? null }))
    return null
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
      if (!await isLive(state)) throw contentKV() ? contentErrorDiagnostics.CONTENT_R0020({ source: state.name }) : contentErrorDiagnostics.CONTENT_R0021({ source: state.name })
      const before = await read(state)
      const reason = await check(state, { id: sha, immutable: true, ...(before?.ref ? { ref: before.ref } : {}) })
      if (reason) throw contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha, reason, head: before?.sha ?? null })
      const head: StoredHead = { origin: origin(state), sha, ref: before?.ref ?? null, movedAt: new Date().toISOString(), pinned: true, rejected: before?.rejected ?? null, rejectionResolved: true }
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

  /** The `repo` and `ref` of a `github()` Source. `ref` is undefined for the default branch. */
  function target(state: HeadState): { repo: string, ref: string | undefined } | undefined {
    const fingerprint: unknown = state.definition.fingerprint
    if (typeof fingerprint !== "object" || fingerprint === null) return
    const repo: unknown = Reflect.get(fingerprint, "repo")
    const ref: unknown = Reflect.get(fingerprint, "ref")
    if (typeof repo !== "string") return
    return { repo, ref: typeof ref === "string" && ref !== "default" ? ref : undefined }
  }

  const onMoved: Array<(source: string) => Promise<void>> = []
  const runtime: ContentSourceHeadsRuntime = {
    api,
    async dispose() {
      disposed = true
      views.clear()
      await Promise.all([...allViews.values()].map(close))
    },
    async sync(names) {
      await Promise.all([...states.values()].filter(state => names === undefined || names.includes(state.name)).map(state => sync(state)))
    },
    commits(name: string, input: ContentSourceInput, snapshot?: ContentSnapshotLoader): ContentSourceCommits | undefined {
      const definition = contentSourceDefinition(input)
      if (!isGitHubDefinition(definition)) return
      const state: HeadState = { name, input, definition, reported: new Set(), stats: { memory: 0, build: 0, kv: 0, misses: 0 }, access: new AsyncLocalStorage(), ...(snapshot ? { built: openCommitSnapshot(snapshot) } : {}) }
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
    async snapshot(name) {
      const state = stateOf(name)
      if (!await state.definition.authenticated()) return
      const revision = await createSource(state.definition).revision()
      if (!revision?.immutable) return `GitHub gave no commit for the branch of Content source ${JSON.stringify(name)}.`
      const loaded = await parseCommit(state, await createSource(state.definition, { revision }).items())
      if (!loaded.commit) return `Commit ${revision.id} of Content source ${JSON.stringify(name)} failed validation: ${loaded.reason}`
      return { sha: revision.id, ref: revision.ref ?? null, origin: origin(state), json: commitJson(loaded.commit) }
    },
    github: name => states.get(name)?.definition,
    async published(name: string): Promise<string | null> {
      const state = stateOf(name)
      if (await isLive(state)) {
        try {
          const head = await current(state)
          if (head?.sha) return head.sha
        }
        catch (error) {
          if (!isKVFailure(error)) throw error
          if (state.served) return state.served.sha
        }
      }
      const revision = await createSource(state.definition).revision()
      return revision?.immutable ? revision.id : null
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
    onMove(work) {
      onMoved.push(work)
    },
    async moved(name) {
      await Promise.all(onMoved.map(work => work(name)))
    },
    names: () => [...states.keys()],
    async read(ref, read) {
      assertActive()
      const target = givenRef(ref)
      const state = stateOf(target.source)
      const loaded = await load(state, { id: target.sha, immutable: true })
      if (!loaded.commit) throw contentErrorDiagnostics.CONTENT_R0030({ source: state.name, ref: target.ref, sha: target.sha, reason: loaded.reason ?? "the commit has no documents" })
      return await readAt(state, target.sha, (_hub, view) => read(view))
    },
    match(repo, ref, defaultBranch) {
      const result: { repository: boolean, sources: string[] } = { repository: false, sources: [] }
      for (const state of states.values()) {
        const source = target(state)
        if (!source || source.repo.toLowerCase() !== repo.toLowerCase()) continue
        result.repository = true
        const branch = source.ref ?? defaultBranch
        if (branch && (ref === `refs/heads/${branch}` || ref === branch)) result.sources.push(state.name)
      }
      return result
    },
    async deliver(name, { id, sha }) {
      const state = stateOf(name)
      const at = new Date().toISOString()
      let delivery: ContentSourceWebhookDelivery
      try {
        const before = await isLive(state) ? await read(state) : null
        const head = await api.advance(name)
        if (!head.live) throw contentKV() ? contentErrorDiagnostics.CONTENT_R0020({ source: name }) : contentErrorDiagnostics.CONTENT_R0021({ source: name })
        const result = head.pinned ? "pinned" : sha && head.rejected?.sha === sha ? "rejected" : head.sha !== (before?.sha ?? null) ? "moved" : "kept"
        delivery = { id, at, sha, result }
      }
      catch (error) {
        delivery = { id, at, sha, result: "failed", error: error instanceof Error ? error.message : String(error) }
      }
      const store = contentKV()
      if (store) {
        const [error] = await store.set(webhookKey(name), delivery)
        if (error) throw error
      }
      return delivery
    },
  }
  runtimes.set(api, runtime)
  return runtime
}
