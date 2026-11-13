import type { AnyExtension, JSONContent } from "@tiptap/core"
import type { WorkspaceSnapshot } from "@vite-hub/workspace"
import type { ViteHubContext } from "@vite-hub/runtime"

/** JSON value stored in one field of a structured Realtime document. */
export type RealtimeFieldValue = null | boolean | number | string | RealtimeFieldValue[] | { [key: string]: RealtimeFieldValue }

/** Plain document state that crosses the document adapter boundary. */
export interface RealtimeDocumentSnapshot {
  /** Structured fields. Each key is one last-write-wins entry in the `fields` Y.Map. */
  fields?: Record<string, RealtimeFieldValue>
  /** Markdown body, encoded and decoded by the definition's editor codec. */
  body: string
}

export interface RealtimeLoadedDocument extends RealtimeDocumentSnapshot {
  /** Version of the stored document, or `null` when it does not exist yet. */
  digest: string | null
}

/** A validation problem reported by a document adapter. Saving still succeeded. */
export interface RealtimeIssue {
  field?: string
  message: string
  path?: Array<string | number>
}

/** Identity resolved on the server. Presence shows `name` and `image`; `id` keys awareness colours. */
export interface RealtimeUser {
  email?: string
  id: string
  image?: string
  name?: string
}

export interface RealtimeDocumentContext {
  /**
   * Room authority holding the live document: one process (`memory`), a Durable Object (`cloudflare`), or rooms that
   * several Node instances share through Postgres (`postgres`) or Redis (`redis`).
   */
  authority: "cloudflare" | "memory" | "postgres" | "redis"
  definition: string
  documentId: string
}

export interface RealtimeSaveOptions {
  /** Users who changed the room since the previous save, in order of their latest edit. */
  editors: RealtimeUser[]
  /** Compare-and-set guard: the digest the room was seeded from or last saved as. `null` means create. */
  ifDigest: string | null
  /** Why Realtime saves: debounced edits, the last client leaving, or an explicit client request. */
  reason: "idle" | "leave" | "request"
  /** The most recent editor, when identified. */
  user?: RealtimeUser
}

export interface RealtimeSaveResult {
  digest: string
  issues?: RealtimeIssue[]
  /**
   * The stored form when the adapter normalized what it received. Realtime merges the
   * difference into the live room without resetting clients.
   */
  stored?: RealtimeDocumentSnapshot
}

export interface RealtimeHistoryOptions {
  /** Digest of the save that the history entry must contain. */
  digest: string
  message?: string
  user?: RealtimeUser
}

/**
 * Loads and stores one kind of Realtime document. The live room keeps the Yjs state as
 * its source of truth; the adapter receives plain snapshots and owns the stored copy.
 */
export interface RealtimeDocumentAdapter {
  /** Short label shown by `vitehub inspect`, for example `workspace` or `content`. */
  kind?: string
  load(context: RealtimeDocumentContext): Promise<RealtimeLoadedDocument>
  /**
   * Store a snapshot only when the stored digest still equals `ifDigest`. Throw
   * `RealtimeDocumentConflict` when it does not; Realtime then reloads and re-seeds the room.
   */
  save(context: RealtimeDocumentContext, document: RealtimeDocumentSnapshot, options: RealtimeSaveOptions): Promise<RealtimeSaveResult>
  /** Optional durable history entry, used by `history.checkpoint()`. */
  checkpoint?(context: RealtimeDocumentContext, options: RealtimeHistoryOptions): Promise<WorkspaceSnapshot>
  /**
   * Optional. Called while a writable room has clients: when a client joins or leaves, and every 60 seconds. `users`
   * are the identified users connected now. Use it to keep a lease, such as the live edit lease of a Content document.
   * A thrown error shows in the room `status` until the next successful call.
   */
  hold?(context: RealtimeDocumentContext, options: RealtimeHoldOptions): Promise<void> | void
  /** Optional. Called once after the last client left a room that `hold()` kept, after the room saved its edits. */
  release?(context: RealtimeDocumentContext): Promise<void> | void
}

export interface RealtimeHoldOptions {
  /** Identified users connected to the room now, in the order they joined. */
  users: RealtimeUser[]
}

export interface RealtimeWorkspaceDocumentOptions {
  /** Workspace whose working tree stores the Markdown file at the document path. */
  workspace: string
}

/**
 * Editor schema and Markdown codec shared by the server and the browser. The server never
 * creates an editor view: it builds the schema from `extensions()` and calls the codec.
 */
export interface RealtimeEditor {
  extensions(): AnyExtension[]
  /**
   * Version of the schema and codec. Change it when a new `extensions()` or codec cannot read the Yjs state of the
   * previous one, such as a node type that was removed or renamed. A room persisted under another version opens fresh
   * from the stored Markdown, and a browser that connects with another version is read-only until it reloads.
   */
  version?: string
  fromMarkdown(markdown: string): Promise<JSONContent> | JSONContent
  toMarkdown(document: JSONContent): Promise<string> | string
  /**
   * Checks a stored document when a room opens. Return `writable: false` when the codec
   * cannot edit it without loss: the room then opens read-only and never saves.
   */
  verify?(markdown: string, options: { fields?: Record<string, RealtimeFieldValue> }): Promise<RealtimeVerifyResult> | RealtimeVerifyResult
}

/** Result of `RealtimeEditor.verify()` for one stored document. */
export interface RealtimeVerifyResult {
  /**
   * The body this codec writes for the unchanged document, when it differs from the stored
   * body only in form. A save whose body equals it, with unchanged fields, writes nothing.
   */
  canonical?: string
  /** Problems shown in the room `status` until the first save. */
  issues?: RealtimeIssue[]
  /** `false` opens the room read-only: no saves, and clients cannot change the body or fields. */
  writable: boolean
}

/**
 * Why a connection is read-only: `access` (authorization denied write), `document` (the codec cannot edit it
 * losslessly), or `version` (the browser runs another editor version than the server, so it must reload to edit).
 */
export type RealtimeReadOnlyReason = "access" | "document" | "version"

/**
 * The request event of a WebSocket upgrade or HTTP request. Read the request, its cookies, and the platform bindings
 * from `event["~standard"]`. `context` is the H3 event context, such as the session that a middleware set.
 */
export type RealtimeRequestEvent = ViteHubContext<{ context: Record<string, unknown> }>

export interface RealtimeRequestContext {
  definition: string
  /** The request event of the WebSocket upgrade or HTTP request. */
  event: RealtimeRequestEvent
  request: Request
}

export interface RealtimeOriginContext extends RealtimeRequestContext {
  /** The `Origin` header of a request from another origin than the app's. */
  origin: string
}

export interface RealtimeAuthorizeContext extends RealtimeRequestContext {
  /** Requested document, or `null` for the definition's Workspace event channel. */
  documentId: string | null
  mode: "read" | "write"
  user: RealtimeUser | null
}

export interface RealtimePersistenceOptions {
  /** Quiet period after the last edit before saving. Default 2000 ms. */
  debounce?: number
  /** Longest time edits wait while editing continues. Default 10000 ms. */
  maxWait?: number
}

interface RealtimeDefinitionAccess {
  /** Require an identified user. Without `identify`, the identity is the ViteHub Auth session. */
  auth?: boolean
  /** Resolve the user for a request, replacing the ViteHub Auth session. Return `null` for anonymous. */
  identify?: (context: RealtimeRequestContext) => RealtimeUser | null | undefined | Promise<RealtimeUser | null | undefined>
  /**
   * Let a page on another origin connect to a definition with `identify`, such as a script that sites load from the
   * app. Return `true` to accept `origin`. Without it, only the app's own origin connects. The browser sends cookies
   * with a cross-site handshake too, so `identify` must then trust only what the page sends on purpose, such as a
   * ticket in `params`, never the session cookie.
   */
  origins?: (context: RealtimeOriginContext) => boolean | Promise<boolean>
  /** Allow or deny one access mode. Return `false` to deny. Write denial makes a connection read-only. */
  authorize?: (context: RealtimeAuthorizeContext) => boolean | void | Promise<boolean | void>
}

/** A definition whose rooms edit one stored document each. */
export interface RealtimeDocumentDefinition extends RealtimeDefinitionAccess {
  document: RealtimeWorkspaceDocumentOptions | RealtimeDocumentAdapter
  /**
   * Editor schema and Markdown codec. Defaults to the built-in Markdown kit. A function picks the codec of each
   * document, such as one per Content collection; browsers that open the document must use the same schema.
   */
  editor?: RealtimeEditor | ((context: RealtimeDocumentContext) => RealtimeEditor)
  history?: {
    checkpoint: true | { message?: string }
  }
  /** Idle saves. `false` saves only when a client calls `save()` or `history.checkpoint()`. */
  persistence?: RealtimePersistenceOptions | false
}

/**
 * A definition whose rooms hold no document, only presence: who is in the room and the awareness fields each client
 * sets, such as a cursor. Nothing loads or saves, and `authorize()` is asked only for `read`. Join its rooms with
 * `connectRealtimeRoom()` from `@vite-hub/realtime/client`.
 */
export interface RealtimePresenceDefinition extends RealtimeDefinitionAccess {
  document: false
  editor?: never
  history?: never
  persistence?: never
}

export type RealtimeDefinition = RealtimeDocumentDefinition | RealtimePresenceDefinition

/** Server-written save state, mirrored in the read-only `status` Y.Map. */
export interface RealtimeDocumentStatus {
  digest: string | null
  /** Message of the latest failed save, cleared by the next successful save. */
  error: string | null
  issues: RealtimeIssue[]
  savedAt: string | null
  savedBy: RealtimeUser | null
}

export interface RealtimeSaved extends RealtimeDocumentStatus {
  document: RealtimeDocumentSnapshot
}

export interface RealtimeCheckpoint extends RealtimeSaved {
  digest: string
  snapshot: WorkspaceSnapshot
}

export interface DiscoveredRealtimeDefinition {
  handler: string
  name: string
  /** `server-realtime` for a file in `server/realtime/`; `contributed` for one another package adds, such as Content. */
  source: "contributed" | "server-realtime"
}

export interface RealtimeOptions {
  /**
   * Where rooms live. `auto` (default) picks Durable Objects on Cloudflare and memory on the dev server. A Node build
   * picks when the server starts: Redis with `REDIS_URL`, else Postgres on the connection of the Default Database when it
   * is on Postgres (`REALTIME_POSTGRES_URL` overrides it), else memory. `postgres` and `redis` require their connection.
   * `memory` keeps rooms in one process.
   */
  authority?: "auto" | "cloudflare" | "memory" | "postgres" | "redis"
  /**
   * Keeps the rooms of this app apart from other apps on the same Redis or Postgres. Defaults to the `name` of
   * `vitehub()`, else the `name` in the root `package.json`, else the root folder name. `REALTIME_NAMESPACE` replaces
   * it when the server starts.
   */
  namespace?: string
  projectRoot?: string
}

export interface RealtimePerson {
  clientId: number
  color: string
  id: string
  image?: string
  name: string
}

export type RealtimeWorkspaceChange =
  | { operation: "create" | "delete" | "update", path: string }
  | { operation: "move", from: string, to: string }

export type RealtimeResetReason = "source-changed" | "stale"

export type RealtimeRegistry = Record<string, () => Promise<{ default: RealtimeDefinition }>>

/**
 * Codes that `save()`, `history.checkpoint()`, and `refresh()` of `useRealtimeTiptap()` return in the `[error, data]` tuple.
 */
export type RealtimeRequestErrorCode =
  | "REALTIME_DISABLED"
  | "REALTIME_DISCONNECTED"
  | "REALTIME_INVALID_RESPONSE"
  | "REALTIME_MISSING_DOCUMENT"
  | "REALTIME_REQUEST_FAILED"

/**
 * Whether this build has a Realtime room authority. ViteHub generates it for each build; an unavailable build says why
 * and how to enable Realtime.
 */
export type RealtimeAvailability =
  | { available: true }
  | { available: false, host?: string, reason: string, fix: string }
