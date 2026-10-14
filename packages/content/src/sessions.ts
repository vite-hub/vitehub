import { ViteHubError } from "@vite-hub/runtime"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { resolveWorkspaceStoreTarget, useWorkspace } from "@vite-hub/workspace"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ReportInput, SessionKey, SessionRow, SessionTimeouts, createSessionStore } from "./sessions-store.ts"

/**
 * How long sessions count, in milliseconds. A report keeps a session present for `presence`. Taking or renewing the
 * edit lease keeps it for `lease`. A lease without reported input for `idle` stops blocking others.
 */
export const contentSessionTimeouts: Readonly<SessionTimeouts> = Object.freeze({ presence: 45_000, lease: 300_000, idle: 900_000 })

/** Who a session belongs to. The Console passes the signed-in user; an Agent passes its Actor. */
export interface ContentSessionUser {
  id: string
  name?: string | null
  image?: string | null
}

/** One editor session on one document. */
export interface ContentSession {
  collection: string
  id: string
  /** The token of the tab or client that reported it. */
  session: string
  user: { id: string, name: string | null, image: string | null }
  /** `edit` while it holds the edit lease, or reported editing in a collection without leases. Otherwise `view`. */
  kind: "view" | "edit"
  /** When it started editing, as an ISO timestamp. Null while it views. */
  since: string | null
  /** Its last report. */
  seenAt: string
  /** When it stops counting without another report or renewal. */
  expiresAt: string
  /** Its last reported input, or null. */
  inputAt: string | null
}

/** The sessions of one document after a report, an acquire, or a release. */
export interface ContentDocumentSessions {
  collection: string
  id: string
  /** Whether the calling session may edit: it holds the lease, or the collection has no leases and it reported `edit`. */
  editing: boolean
  /** The session that holds the edit lease, or null. Always null in a collection with `editing: { lease: false }`. */
  holder: ContentSession | null
  /** Every live session of the document, the caller included: editors first, then by last report. */
  sessions: ContentSession[]
  /** Whether the collection uses edit leases. */
  lease: boolean
  /** The Database clock at the call, as an ISO timestamp. Compare `expiresAt` and `since` with it, not the local clock. */
  now: string
}

export interface ContentSessionOptions {
  /**
   * A token for this tab or client, such as `crypto.randomUUID()`: 8 to 128 letters, digits, `-`, or `_`. Use one per
   * editor instance, not one per user, so two tabs of the same user do not share a lease.
   */
  session: string
  user: ContentSessionUser
}

export interface ContentSessionReportOptions extends ContentSessionOptions {
  /** `view` keeps the session present and drops a lease it holds. `edit` also renews the lease it holds. */
  kind: "view" | "edit"
  /** True when the user typed or changed something since the last report. A lease without input for 15 minutes goes idle. */
  input?: boolean
}

export interface ContentSessionAcquireOptions extends ContentSessionOptions {
  /** Take the lease from the session that holds it. Its holder keeps viewing and its saves fail with `CONTENT_LEASE_HELD`. */
  takeover?: boolean
}

export interface ContentSessionReleaseOptions {
  session: string
}

/**
 * Presence and edit leases of Content documents, kept in the Database of the Content Workspace. A lease is advisory
 * for readers and enforced for writes: while one session holds it, `save()`, `remove()`, and `restore()` from any other
 * caller fail with `CONTENT_LEASE_HELD` unless they pass `lease: 'override'`. `ifDigest` still guards every save.
 */
export interface ContentSessions<TCollection extends string = string> {
  /**
   * Report that a session has a document open. Call it about every 15 seconds while visible and every 60 seconds while
   * hidden. `kind: 'edit'` renews a lease the session holds; it never takes a free one, so use `acquire()` for that.
   */
  report(collection: TCollection, id: string, options: ContentSessionReportOptions): Promise<ContentDocumentSessions>
  /** Report on a singleton defined with `singleton()`. */
  report(collection: TCollection, options: ContentSessionReportOptions): Promise<ContentDocumentSessions>
  /**
   * Take the edit lease for 5 minutes when no other session holds it, or with `takeover`. Check `editing` in the
   * result: false means another session holds it, named in `holder`.
   */
  acquire(collection: TCollection, id: string, options: ContentSessionAcquireOptions): Promise<ContentDocumentSessions>
  acquire(collection: TCollection, options: ContentSessionAcquireOptions): Promise<ContentDocumentSessions>
  /** Close the session on the document: it leaves presence and frees its lease. Call it when the editor closes. */
  release(collection: TCollection, id: string, options: ContentSessionReleaseOptions): Promise<void>
  release(collection: TCollection, options: ContentSessionReleaseOptions): Promise<void>
  /** Every live session, of one collection or of all, for list rows and dashboards. */
  list(collection?: TCollection): Promise<ContentSession[]>
}

/** What the sessions runtime needs from a collection. */
export interface SessionCollection {
  name: string
  /** False for `editing: { lease: false }`. */
  lease: boolean
  /** The document id, after checking it; a singleton fills it in. */
  documentId(id: string | undefined): string
}

type SessionStore = ReturnType<typeof createSessionStore>

const sessionToken = /^[\w-]{8,128}$/
const missingTableRetryMs = 60_000

function invalid(message: string): Error {
  return contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] ${message}` })
}

function setupError(message: string): Error {
  return contentErrorDiagnostics.CONTENT_R0012({ message: `[vitehub] ${message}` })
}

/** True when the Database has no sessions table yet, from libSQL, D1, or a Drizzle wrapper of either. */
function isMissingTable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; current = Reflect.get(Object(current), "cause"), depth++) {
    const message: unknown = Reflect.get(Object(current), "message")
    if (String(message) === message && /no such table:?\s*"?vitehub_content_sessions/i.test(message)) return true
  }
  return false
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString()
}

function textField(value: unknown, name: string, maximum: number): string | null {
  if (value === undefined || value === null) return null
  if (String(value) !== value) throw invalid(`content.sessions user.${name} must be a string.`)
  return value.slice(0, maximum) || null
}

function readUser(user: unknown): { id: string, name: string | null, image: string | null } {
  if (user === null || Object(user) !== user) throw invalid("content.sessions requires user: { id, name?, image? }.")
  const id: unknown = Reflect.get(Object(user), "id")
  if (String(id) !== id || !id || id.length > 256) throw invalid("content.sessions user.id must be a non-empty string of at most 256 characters.")
  return { id, name: textField(Reflect.get(Object(user), "name"), "name", 256), image: textField(Reflect.get(Object(user), "image"), "image", 2048) }
}

function readSession(options: unknown): string {
  const session: unknown = options !== null && Object(options) === options ? Reflect.get(Object(options), "session") : undefined
  if (String(session) !== session || !sessionToken.test(session)) {
    throw invalid("content.sessions requires session: a token of 8 to 128 letters, digits, - or _, one per tab or client.")
  }
  return session
}

/** Create `content.sessions` over the Database of the Workspace's Blob + Database Store. */
export function createContentSessions(options: {
  workspace: string
  collection: (name: unknown) => SessionCollection
}): ContentSessions & {
  /** The live lease another session holds on a document, for writes. Undefined when there is none or no sessions table. */
  holder(collection: SessionCollection, id: string, session: string | undefined): Promise<ContentSession | undefined>
  /** Renew the lease the session holds after one of its writes. */
  renew(collection: SessionCollection, id: string, session: string): Promise<void>
} {
  let storePromise: Promise<SessionStore> | undefined
  /** When writes last found no sessions table. They skip the lease check for a minute instead of failing a query each save. */
  let missingSince: number | undefined

  function store(): Promise<SessionStore> {
    storePromise ??= (async () => {
      // SAFETY: Content accepts any Workspace name; the registry rejects unknown names when the facade resolves.
      const workspace = useWorkspace(options.workspace as never, { mode: "write" })
      const target = await resolveWorkspaceStoreTarget(workspace)
      const database: unknown = target && Reflect.get(Object(target), "database")
      if (target?.provider !== "blob-database" || database === null || Object(database) !== database) {
        throw setupError(`Content sessions keep presence and edit leases in the Database of the Workspace history, but Workspace ${JSON.stringify(options.workspace)} uses the ${JSON.stringify(target?.provider ?? "unknown")} Store. Use the Blob + Database Store.`)
      }
      const { createSessionStore } = await import("./sessions-store.ts")
      // SAFETY: The Blob + Database Store target carries the Drizzle Database its history uses.
      return createSessionStore(database as Parameters<typeof createSessionStore>[0], options.workspace, contentSessionTimeouts)
    })()
    storePromise.catch(() => {
      storePromise = undefined
    })
    return storePromise
  }

  /** Run a sessions call, and name the fix when the Database lacks the table. */
  async function run<T>(call: (sessions: SessionStore) => Promise<T>): Promise<T> {
    const sessions = await store()
    try {
      const result = await call(sessions)
      missingSince = undefined
      return result
    }
    catch (error) {
      if (!isMissingTable(error)) throw error
      throw setupError(`Content sessions need the vitehub_content_sessions table in the Database of Workspace ${JSON.stringify(options.workspace)}. Add contentSessionsSchema from 'vite-hub/content/database' to that Database next to workspaceHistorySchema, then run \`vitehub db generate\` and \`vitehub db migrate\`.`)
    }
  }

  function view(row: SessionRow, lease: boolean): ContentSession {
    const leaseLive = row.kind === "edit" && row.expiresAt > row.now && row.lastInputAt !== null && row.lastInputAt > row.now - contentSessionTimeouts.idle
    const kind = row.kind === "edit" && (!lease || leaseLive) ? "edit" : "view"
    return {
      collection: row.collection,
      id: row.document,
      session: row.session,
      user: { id: row.userId, name: row.userName, image: row.userImage },
      kind,
      since: kind === "edit" ? iso(row.acquiredAt ?? row.renewedAt) : null,
      seenAt: iso(row.renewedAt)!,
      expiresAt: iso(row.expiresAt)!,
      inputAt: iso(row.lastInputAt),
    }
  }

  function ordered(sessions: ContentSession[]): ContentSession[] {
    return sessions.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "edit" ? -1 : 1) || right.seenAt.localeCompare(left.seenAt) || left.session.localeCompare(right.session))
  }

  /** Read `(collection, id, options)` or a singleton's `(collection, options)`. */
  function target(collectionName: unknown, idOrOptions: unknown, maybeOptions: unknown): { collection: SessionCollection, id: string, options: unknown } {
    const collection = options.collection(collectionName)
    const hasId = hasRuntimeType(idOrOptions, "string")
    return { collection, id: collection.documentId(hasId ? idOrOptions : undefined), options: hasId ? maybeOptions : idOrOptions }
  }

  async function report(collectionName: unknown, idOrOptions: unknown, maybeOptions: unknown, mode: "report" | "acquire"): Promise<ContentDocumentSessions> {
    const { collection, id, options: input } = target(collectionName, idOrOptions, maybeOptions)
    const session = readSession(input)
    const user = readUser(Reflect.get(Object(input), "user"))
    let kind: ReportInput["kind"] = "edit"
    if (mode === "report") {
      const requested: unknown = Reflect.get(Object(input), "kind")
      if (requested !== "view" && requested !== "edit") throw invalid("content.sessions.report() requires kind: 'view' or 'edit'.")
      kind = requested
    }
    const takeover = mode === "acquire" && Reflect.get(Object(input), "takeover") === true
    const key: SessionKey = { collection: collection.name, document: id, session }
    const rows = await run(sessions => sessions.report({
      ...key,
      user,
      kind,
      input: mode === "acquire" || Reflect.get(Object(input), "input") === true,
      lease: collection.lease,
      claim: mode === "acquire",
      takeover,
    }))
    const all = ordered(rows.map(row => view(row, collection.lease)))
    const self = all.find(entry => entry.session === session)
    const holder = collection.lease ? all.find(entry => entry.kind === "edit") ?? null : null
    return {
      collection: collection.name,
      id,
      editing: self?.kind === "edit",
      holder,
      sessions: all,
      lease: collection.lease,
      now: iso(rows[0]?.now ?? Date.now())!,
    }
  }

  return {
    report: ((collection: unknown, idOrOptions: unknown, maybeOptions?: unknown) => report(collection, idOrOptions, maybeOptions, "report")) as ContentSessions["report"],
    acquire: ((collection: unknown, idOrOptions: unknown, maybeOptions?: unknown) => report(collection, idOrOptions, maybeOptions, "acquire")) as ContentSessions["acquire"],
    release: (async (collectionName: unknown, idOrOptions: unknown, maybeOptions?: unknown) => {
      const { collection, id, options: input } = target(collectionName, idOrOptions, maybeOptions)
      const session = readSession(input)
      await run(sessions => sessions.release({ collection: collection.name, document: id, session }))
    }) as ContentSessions["release"],
    async list(collectionName?: string) {
      const collection = collectionName === undefined ? undefined : options.collection(collectionName)
      const rows = await run(sessions => sessions.list(collection?.name))
      const leases = new Map<string, boolean>()
      const leaseOf = (name: string) => {
        if (!leases.has(name)) {
          let lease = true
          try {
            lease = options.collection(name).lease
          }
          catch {
            // A row of a collection that is no longer defined keeps the default.
          }
          leases.set(name, lease)
        }
        return leases.get(name)!
      }
      return ordered(rows.map(row => view(row, leaseOf(row.collection))))
        .sort((left, right) => left.collection.localeCompare(right.collection) || left.id.localeCompare(right.id))
    },
    async holder(collection, id, session) {
      if (!collection.lease) return
      if (missingSince !== undefined && Date.now() - missingSince < missingTableRetryMs) return
      let sessions: SessionStore
      try {
        sessions = await store()
      }
      catch {
        // A Workspace without a sessions Database has no leases to honor.
        return
      }
      try {
        const row = await sessions.holder({ collection: collection.name, document: id, session: session ?? "" })
        missingSince = undefined
        return row ? view(row, true) : undefined
      }
      catch (error) {
        if (!isMissingTable(error)) throw error
        missingSince = Date.now()
        return
      }
    },
    async renew(collection, id, session) {
      if (!collection.lease) return
      try {
        await (await store()).renew({ collection: collection.name, document: id, session })
      }
      catch (error) {
        if (!isMissingTable(error)) throw error
      }
    },
  }
}

/** The `CONTENT_LEASE_HELD` error of a write that another session's lease blocks. */
export function contentLeaseHeld(collection: string, id: string, holder: ContentSession): ViteHubError {
  const name = holder.user.name ?? holder.user.id
  return new ViteHubError("CONTENT_LEASE_HELD", `[vitehub] ${name} is editing Content document ${JSON.stringify(`${collection}/${id}`)}. Wait for the lease to end, or pass lease: 'override' to write anyway.`, {
    details: { collection, id, holder: { user: { ...holder.user }, since: holder.since, expiresAt: holder.expiresAt } },
  })
}
