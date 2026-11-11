import { AsyncLocalStorage } from "node:async_hooks"

import { createSource } from "@vite-hub/source"
import type { Source, SourceRevision } from "@vite-hub/source"
import type { ComarkContent, ContentOptions } from "comark-content"
import { formatDiagnostic } from "nostics"

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
}

interface HeadState {
  name: string
  input: ContentSourceInput
  definition: GitHubDefinition
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

/** How long a server instance serves a head before it reads KV again. */
const HOLD_MS = 5_000
const fullSha = /^[0-9a-f]{40}$/i

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
export function registerContentKV(store: ContentKV | undefined): void {
  installedKV = store
}

/** The head state of one Content runtime. */
interface ContentSourceHeadsRuntime {
  /** `content.sources`. */
  api: ContentSourceHeads
  /** Resolve heads before hub reads, including Comark's internal cache and index paths. */
  sync(): Promise<void>
  /** The revision getter of a `github()` Source for `createContentInstance()`, or undefined for other Sources. */
  revision(name: string, input: ContentSourceInput): (() => Promise<SourceRevision | undefined>) | undefined
  /** Give a `github()` Source its Comark instance, so a moved head reloads it. */
  attach(name: string, instance: ComarkContent): void
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

  function view(state: HeadState, head: StoredHead | null, live = true): ContentSourceHead {
    return {
      source: state.name,
      live,
      sha: head?.sha ?? null,
      ref: head?.ref ?? null,
      movedAt: head?.movedAt ?? null,
      pinned: head?.pinned ?? false,
      rejected: head?.rejected ?? null,
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
      if (!await isLive(state)) return view(state, null, false)
      const head = await current(state)
      await serve(state, head)
      return view(state, head)
    },
    async advance(source) {
      const state = stateOf(source)
      if (!await isLive(state)) return view(state, null, false)
      const head = await move(state)
      hold(state, head)
      await serve(state, head)
      return view(state, head)
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
      return view(state, head)
    },
    async unpin(source) {
      const state = stateOf(source)
      if (!await isLive(state)) return view(state, null, false)
      const before = await read(state)
      if (before?.pinned) await write(state, { ...before, pinned: false })
      return await api.advance(source)
    },
  }

  return {
    api,
    async sync() {
      await Promise.all([...states.values()].map(state => sync(state)))
    },
    revision(name: string, input: ContentSourceInput): (() => Promise<SourceRevision | undefined>) | undefined {
      const definition = contentSourceDefinition(input)
      if (!isGitHubDefinition(definition)) return
      const state: HeadState = { name, input, definition, reported: new Set(), access: new AsyncLocalStorage() }
      states.set(name, state)
      return async () => {
        if (!state.access.getStore()) await state.access.run(true, () => sync(state))
        return state.served ? { id: state.served.sha, immutable: true, ...(state.served.ref ? { ref: state.served.ref } : {}) } : undefined
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
