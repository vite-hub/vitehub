import { createSource } from "@vite-hub/source"
import type { Source, SourceRevision } from "@vite-hub/source"
import type { ComarkContent, ContentOptions } from "comark-content"
import { formatDiagnostic } from "nostics"
import type { Diagnostic } from "nostics"

import { contentSourceDefinition, createContentInstance } from "./content-source.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ContentSourceInput } from "./content-source.ts"

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

/** The head commits of `github()` Sources. */
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
}

/** A `github()` Source definition. */
type GitHubDefinition = Source<string, unknown, object> & { authenticated(): Promise<boolean> }

/** The KV value of a head. */
interface StoredHead {
  /** The Source fingerprint the head belongs to. A head of another repository or ref is ignored. */
  origin: string
  sha: string | null
  ref: string | null
  movedAt: string | null
  pinned: boolean
  rejected: ContentSourceHead["rejected"]
  /** When a server instance last resolved the branch. Older heads do not have it. */
  checkedAt?: string | null
}

interface HeadState {
  name: string
  input: ContentSourceInput
  definition: GitHubDefinition
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
  /** The reload of the instance after the head moved. Reads wait for it. */
  refreshing?: Promise<void>
  /** Rejected commits that this server instance already reported. */
  reported: Set<string>
  /** When KV last failed on a read. Reads skip KV until `failed + HOLD_MS`. */
  failed?: number
}

/** How long a server instance serves a head before it reads KV again. */
const HOLD_MS = 5_000
/** How long a head waits for a push before a read resolves the branch again. A push webhook moves it sooner. */
const CHECK_MS = 60 * 60 * 1000
const fullSha = /^[0-9a-f]{40}$/i

/** The KV key of a head, such as `content:head:docs`. `vitehub kv get content:head:docs` shows it. */
function headKey(name: string): string {
  return `content:head:${name}`
}

/** The KV key of the last push webhook delivery of a Source, such as `content:webhook:docs`. */
function webhookKey(name: string): string {
  return `content:webhook:${name}`
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

/**
 * Give Content the KV store that keeps the heads of `github()` Sources. When the app enables ViteHub KV, the build
 * calls it at the top of `server/content.ts`; you do not call it yourself. Without it, no Source is live.
 */
export function registerContentKV(store: ContentKV | undefined): void {
  installedKV = store
}

/** The head state of one Content runtime. */
interface ContentSourceHeadsRuntime {
  /** `content.sources`. */
  api: ContentSourceHeads
  /** The revision getter of a `github()` Source for `createContentInstance()`, or undefined for other Sources. */
  revision(name: string, input: ContentSourceInput): (() => SourceRevision | undefined) | undefined
  /** Give a `github()` Source its Comark instance, so a moved head reloads it. */
  attach(name: string, instance: ComarkContent): void
  /** Bring every live Source to its current head before a read. */
  sync(): Promise<void>
  /** The names of the `github()` Sources. */
  names(): string[]
  /** The names of the `github()` Sources that follow `ref` of `repo`. `defaultBranch` resolves a Source without `ref`. */
  match(repo: string, ref: string, defaultBranch: string | undefined): { repository: boolean, sources: string[] }
  /** Advance a Source for a push webhook delivery and keep the delivery in KV, where `head()` shows it. */
  deliver(source: string, delivery: { id: string | null, sha: string | null }): Promise<ContentSourceWebhookDelivery>
}

const runtimes = new WeakMap<object, ContentSourceHeadsRuntime>()

/** The runtime behind `content.sources`, for the push webhook route and the Content operations. */
export function contentSourceHeadsRuntime(api: object): ContentSourceHeadsRuntime | undefined {
  return runtimes.get(api)
}

/** Create the head state of a Content runtime. `options` are the Comark options that validation parses with. */
export function createContentSourceHeads(options: ContentOptions): ContentSourceHeadsRuntime {
  const states = new Map<string, HeadState>()

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
      else if (!installedKV) state.offline = diagnosticOf("CONTENT_R0021", contentErrorDiagnostics.CONTENT_R0021({ source: state.name }), true)
      return !state.offline
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

  /** Load and parse every document of `input`. Returns the error, or undefined when every document parses. */
  async function parse(name: string, input: ContentSourceInput, revision?: SourceRevision): Promise<string | undefined> {
    const instance = createContentInstance(name, input, { ...options, cache: false, logger: false, onError: "throw" }, undefined, revision && (() => revision))
    // Index plugins, such as `sql-query`, write their tables on `file:bulk:load`. A check must not change them.
    const { hooks } = instance
    const callHook = hooks.callHook
    hooks.callHook = ((hook: string, ...args: unknown[]) => hook === "file:bulk:load" ? Promise.resolve() : Reflect.apply(callHook, hooks, [hook, ...args])) as typeof callHook
    try {
      await instance.init({ partial: false, ignoreCache: true })
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    finally {
      await instance.dispose()
    }
  }

  /**
   * Load and parse every document of one commit. Returns why the commit is invalid, or undefined when it is valid.
   * This is the seam for `vitehub content check`, which adds schema, link, and SEO checks.
   */
  async function check(state: HeadState, revision: SourceRevision): Promise<string | undefined> {
    const failure = await parse(state.name, state.input, revision)
    if (!failure) return
    // Parse errors, such as YAML errors, do not name the document. Parse each document alone to find it.
    try {
      for (const item of await createSource(state.definition, { revision }).items()) {
        const single: Source<string, unknown, object> = { name: state.definition.name, getKeys: async () => [item.key], getItem: async () => item }
        const error = await parse(state.name, single)
        if (error) return `${item.path ?? item.key}: ${error}`
      }
    }
    // A Source that fails to load again keeps the first error.
    catch {}
    return failure
  }

  /** Move the head to the latest valid commit of the branch, and return the stored head. */
  async function move(state: HeadState): Promise<StoredHead | null> {
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
    if (revision.id === before?.sha || revision.id === before?.rejected?.sha) return before
    const reason = await check(state, revision)
    const now = new Date().toISOString()
    const next: StoredHead = reason
      ? { ...(before ?? { origin: origin(state), sha: null, ref: revision.ref ?? null, movedAt: null, pinned: false }), rejected: { sha: revision.id, at: now, reason }, checkedAt: now }
      : { origin: origin(state), sha: revision.id, ref: revision.ref ?? null, movedAt: now, pinned: false, rejected: null, checkedAt: now }
    // Another server instance moved the head while this one validated. Its head wins, so an older commit never replaces it.
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

  /**
   * The head without a push for one hour resolves its branch again, so it moves without a webhook too. The server
   * instance that reads it first writes the time before it checks, so other server instances do not check too.
   */
  async function recheck(state: HeadState, head: StoredHead): Promise<StoredHead | null> {
    const checkedAt = Date.parse(head.checkedAt ?? head.movedAt ?? "")
    if (head.pinned || Date.now() - (Number.isNaN(checkedAt) ? 0 : checkedAt) < CHECK_MS) return head
    await write(state, { ...head, checkedAt: new Date().toISOString() })
    return await move(state)
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

  /** Point the instance at `head`, and reload it when it already loaded another commit. */
  async function serve(state: HeadState, head: StoredHead | null): Promise<void> {
    const sha = head?.sha ?? undefined
    const instance = state.instance
    if (sha !== state.served?.sha) {
      state.served = head?.sha ? { sha: head.sha, ref: head.ref } : undefined
      if (instance && instance.status !== "created" && instance.status !== "disposed") {
        const refreshing = instance.refresh().then(() => undefined)
        state.refreshing = refreshing
        void refreshing.finally(() => {
          if (state.refreshing === refreshing) state.refreshing = undefined
        }).catch(() => {})
      }
    }
    await state.refreshing
  }

  async function lastDelivery(state: HeadState): Promise<ContentSourceWebhookDelivery | null> {
    if (!installedKV) return null
    const [error, delivery] = await installedKV.get<ContentSourceWebhookDelivery>(webhookKey(state.name))
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
    return {
      source: state.name,
      live,
      sha: head?.sha ?? null,
      ref: head?.ref ?? null,
      movedAt: head?.movedAt ?? null,
      pinned: head?.pinned ?? false,
      rejected: head?.rejected ?? null,
      checkedAt: head?.checkedAt ?? null,
      webhook: await lastDelivery(state),
      diagnostic: diagnostic(state, head, live),
    }
  }

  function diagnostic(state: HeadState, head: StoredHead | null, live: boolean): ContentSourceHeadDiagnostic | null {
    if (!live) return state.offline ?? null
    if (state.limited) return state.limited
    if (head?.rejected) return diagnosticOf("CONTENT_R0019", contentErrorDiagnostics.CONTENT_R0019({ source: state.name, sha: head.rejected.sha, reason: head.rejected.reason, head: head.sha }))
    return null
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

  const runtime: ContentSourceHeadsRuntime = {
    api,
    revision(name: string, input: ContentSourceInput): (() => SourceRevision | undefined) | undefined {
      const definition = contentSourceDefinition(input)
      if (!isGitHubDefinition(definition)) return
      const state: HeadState = { name, input, definition, reported: new Set() }
      states.set(name, state)
      return () => state.served ? { id: state.served.sha, immutable: true, ...(state.served.ref ? { ref: state.served.ref } : {}) } : undefined
    },
    attach(name: string, instance: ComarkContent): void {
      const state = states.get(name)
      if (state) state.instance = instance
    },
    async sync(): Promise<void> {
      await Promise.all([...states.values()].map(async (state) => {
        if (!await isLive(state)) return
        // After a KV failure, reads keep the fallback for the hold time, so a broken store is not called on each read.
        if (kvFailing(state)) return await serve(state, fallback(state))
        let head: StoredHead | null
        try {
          head = await current(state)
        }
        catch (error) {
          if (!isKVFailure(error)) throw error
          // A KV failure must not fail the page. Content logs it once per hold and reads without the head.
          if (!kvFailing(state)) {
            state.failed = Date.now()
            console.warn(formatDiagnostic(error))
          }
          return await serve(state, fallback(state))
        }
        state.failed = undefined
        await serve(state, head)
      }))
    },
    names: () => [...states.keys()],
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
        if (!head.live) throw installedKV ? contentErrorDiagnostics.CONTENT_R0020({ source: name }) : contentErrorDiagnostics.CONTENT_R0021({ source: name })
        const result = head.pinned ? "pinned" : sha && head.rejected?.sha === sha ? "rejected" : head.sha !== (before?.sha ?? null) ? "moved" : "kept"
        delivery = { id, at, sha, result }
      }
      catch (error) {
        delivery = { id, at, sha, result: "failed", error: error instanceof Error ? error.message : String(error) }
      }
      if (installedKV) {
        const [error] = await installedKV.set(webhookKey(name), delivery)
        if (error) throw error
      }
      return delivery
    },
  }
  runtimes.set(api, runtime)
  return runtime
}
