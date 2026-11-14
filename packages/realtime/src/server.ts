import { assertAuthOrigin } from "@vite-hub/auth/internal/server"
import { isWorkspaceConflict, normalizeSafeWorkspacePath } from "@vite-hub/workspace/files"
import { HTTPError, defineEventHandler, defineWebSocketHandler } from "h3"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { H3Event, WebSocketHooks, WebSocketMessage, WebSocketPeer } from "h3"
import type { RealtimeRequestFrame } from "./protocol.ts"
import type { RealtimeBus, RealtimeBusMessage, RealtimeBusMessageType, RealtimeRoomRecord } from "./bus-protocol.ts"
// Adds `~standard` to the H3Event type. The ViteHub Nitro plugin sets it at runtime.
import type {} from "@vite-hub/runtime/internal/h3"
import type { RealtimeRoomSql } from "./cloudflare-sql.ts"
import type { RealtimeIdentity } from "./presence.ts"
import type {
  RealtimeAuthorizeContext,
  RealtimeCheckpoint,
  RealtimeDefinition,
  RealtimeDocumentAdapter,
  RealtimeDocumentContext,
  RealtimeDocumentDefinition,
  RealtimeEditor,
  RealtimeFieldValue,
  RealtimeIssue,
  RealtimeLoadedDocument,
  RealtimeReadOnlyReason,
  RealtimeRegistry,
  RealtimeResetReason,
  RealtimeSaveOptions,
  RealtimeSaved,
  RealtimeUser,
} from "./types.ts"
import { createRealtimeIdentity } from "./presence.ts"
import { AwarenessOwnershipConflict, compactRealtimeAwareness, createRealtimeAwarenessOwners } from "./awareness.ts"
import { isRealtimeDocumentConflict } from "./conflict.ts"
import {
  checkRealtimeBody,
  containsRealtimeState,
  createRealtimeYDoc,
  diffRealtimeYDoc,
  keepRealtimeFinalNewline,
  readRealtimeStatus,
  readRealtimeYDoc,
  realtimeCodecReadsBack,
  realtimeDocumentLayout,
  realtimeJsonEqual,
  realtimeStatusFingerprint,
  writeRealtimeFields,
  writeRealtimeStatus,
} from "./document.ts"
import { assertRealtimeCheckpoint } from "./definition.ts"
import { realtimeMarkdownEditor } from "./editor.ts"
import {
  decodeRealtimeRequestFramePayload,
  decodeWorkspaceChangePayload,
  encodeRealtimeControl,
  encodeRealtimeRequestFrame,
  encodeWorkspaceChange,
  messageAwareness,
  messageQueryAwareness,
  messageRealtimeRequest,
  messageWorkspaceChange,
  realtimeForbiddenWriteCloseCode,
  realtimeInvalidDocumentCode,
  realtimeKeepalivePing,
  realtimeKeepalivePong,
  realtimeReadOnlyCode,
  realtimeResetCloseCode,
  realtimeSourceChangedCode,
  realtimeSyncPendingCode,
} from "./protocol.ts"
import { readRealtimeRequestState } from "./transport.ts"
import { workspaceDocument } from "./workspace-document.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"
import {
  defaultRequestTimeout,
  defaultRequestWait,
  durableRoomsInstance,
  internalRequestHeader,
  isDurableSockets,
  isRealtimeDurableObjectNamespace,
  localRequesters,
  roomRequestError,
  routePrefix,
  toDurableRequestReply,
  workerDurableObjects,
} from "./request.ts"
import type { DurableSockets, LocalRequestOptions, RealtimeDurableObjectNamespace, RealtimeRoomRequestResult } from "./request.ts"
import { hasNativeCloudflareSql } from "./cloudflare-sql.ts"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

export { isRealtimeAvailable } from "./availability.ts"
export { blobDocument } from "./blob-document.ts"
export type { RealtimeBlobDocumentOptions, RealtimeBlobStore } from "./blob-document.ts"
export { applyRealtimeAwarenessUpdate, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness } from "./awareness.ts"
export { RealtimeDocumentConflict, isRealtimeDocumentConflict } from "./conflict.ts"
export { containsRealtimeState, createRealtimeYDoc, diffRealtimeYDoc, readRealtimeStatus, readRealtimeYDoc, realtimeDocumentLayout } from "./document.ts"
export { readRealtimeRequestState } from "./transport.ts"
export { isRealtimeWorkspaceDocument, readRealtimeWorkspaceDocument, workspaceDocument } from "./workspace-document.ts"
export type { RealtimeWorkspaceDocumentAdapter } from "./workspace-document.ts"

export type { RealtimeBus, RealtimeBusMessage, RealtimeRoomRecord } from "./bus-protocol.ts"
export { requestRealtimeRoom } from "./request.ts"
export type { RealtimeDurableObjectNamespace, RealtimeRoomRequestOptions, RealtimeRoomRequestResult } from "./request.ts"

export interface RealtimeHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

export interface RealtimeHandlerOptions {
  /**
   * Shares the rooms of this server with other instances. ViteHub passes `useRealtimeBus()` from
   * `@vite-hub/realtime/bus` in Node builds. It runs once, when the first room opens. `undefined` keeps the rooms in
   * this process.
   */
  bus?: () => Promise<RealtimeBus | undefined> | RealtimeBus | undefined
}

const maxMessageBytes = 1024 * 1024
const maxRoomStateBytes = 8 * 1024 * 1024
const maxMemoryRooms = 128
const awarenessQueryIntervalMs = 10_000
const awarenessUpdateIntervalMs = 50
const workspaceChangeLimit = 100
const workspaceChangeWindowMs = 1_000
/**
 * Document updates per connection: a burst of 40, refilled at 20 per second. Typing sends one update per keystroke, so
 * fast typing fits. Updates past the budget wait, merged, until it refills (a held key repeats ~30 times a second); a
 * peer that holds back more than one message's worth is closed rather than having updates dropped.
 */
const syncUpdateBurst = 40
const syncUpdatesPerSecond = 20
const durableUpdateCompactionInterval = 128
const maxSaveRetryMs = 60_000
const holdIntervalMs = 60_000
const messageSync = 0
const keepalivePing = new TextEncoder().encode(realtimeKeepalivePing)
/** Marks the request that `refreshRealtimeDocument()` sends to a Durable Object. The Worker strips it from client requests. */
const internalRefreshHeader = "x-vitehub-realtime-refresh"

export const realtimePersistenceDefaults = Object.freeze({ debounce: 2_000, maxWait: 10_000 })

/** Origin of updates that the server writes itself: seeds, stored-form merges, and status. */
const serverOrigin = Symbol("vitehub.realtime.server")
/** Origin of updates that another instance sent over the bus. */
const busOrigin = Symbol("vitehub.realtime.bus")
/** A Yjs update with no structs and no deletions. */
const emptyUpdateBytes = 2
/** The epoch of rooms that hold no document: Workspace event rooms and the rooms of presence definitions. */
const eventsEpoch = "events"

/** The fields that the adapter loaded, without the ones it left undefined. */
function loadedFields(loaded: RealtimeLoadedDocument): Record<string, RealtimeFieldValue> {
  return Object.fromEntries(Object.entries(loaded.fields ?? {}).filter(([, value]) => value !== undefined))
}

/** True when the field map holds exactly these fields, including fields whose value is null. */
function holdsFields(map: Y.Map<unknown>, fields: Record<string, RealtimeFieldValue>): boolean {
  const keys = Object.keys(fields)
  return map.size === keys.length && keys.every(key => map.has(key) && realtimeJsonEqual(map.get(key), fields[key]))
}

const readOnlyDocumentMessage = "The editor cannot save this document without loss. The room is read-only."
const readOnlyDocumentRejection = "This realtime document is read-only: the editor cannot save it without loss."
const invalidDocumentMessage = "The room document does not fit the editor schema, so Realtime did not save it. Undo the last change or reload."
const codecReadBackIssue: RealtimeIssue = {
  message: "The editor cannot read back the Markdown that it saved. Some content can change when the document opens again.",
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

export function encodeSyncStep1(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, document)
  return encoding.toUint8Array(encoder)
}

export function encodeAwarenessState(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  return encodeAwareness(awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
}

function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * The clients that the awareness has a clock for. A client's first awareness update has clock 0, which Yjs does not
 * apply, so the client has no clock yet and cannot be encoded.
 */
function knownAwarenessClients(awareness: awarenessProtocol.Awareness, clients: readonly number[]): number[] {
  return clients.filter(client => awareness.meta.has(client))
}

/** Whether a transaction changed only the server-written `status` map. */
function changesOnlyStatus(document: Y.Doc, transaction: Y.Transaction): boolean {
  const status: object = document.getMap(realtimeDocumentLayout.status)
  for (const type of transaction.changed.keys()) {
    if (type !== status) return false
  }
  return true
}

/** A peer tried to write what it may not: a read-only connection, or the server-written status map. */
export class RealtimeWriteRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RealtimeWriteRejected"
  }
}

export interface RealtimeSyncOptions {
  maxStateBytes?: number
  /** Reject any update that changes the document. A string replaces the rejection message. */
  readOnly?: boolean | string
  /** Reject updates that change the server-written `status` map. Default `true`. */
  protectStatus?: boolean
}

export function applyRealtimeSyncMessage(data: Uint8Array, document: Y.Doc, origin: unknown, options: RealtimeSyncOptions = {}): Uint8Array | undefined {
  const apply = (target: Y.Doc) => {
    const decoder = decoding.createDecoder(data)
    decoding.readVarUint(decoder)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.readSyncMessage(decoder, encoder, target, origin)
    return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined
  }
  const messageDecoder = decoding.createDecoder(data)
  decoding.readVarUint(messageDecoder)
  const syncType = decoding.readVarUint(messageDecoder)
  // Sync step 1 only reads the document to produce a response. Avoid cloning and
  // serializing the whole room for a frame that cannot increase its state.
  if (syncType === 0) return apply(document)
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    const before = Y.snapshot(candidate)
    apply(candidate)
    if (candidate.store.pendingStructs || candidate.store.pendingDs) {
      throw new RealtimeWriteRejected("Realtime update depends on state this room does not have.")
    }
    if (options.readOnly && !Y.equalSnapshots(before, Y.snapshot(candidate))) {
      throw new RealtimeWriteRejected(typeof options.readOnly === "string" ? options.readOnly : "This realtime connection is read-only.")
    }
    if (options.protectStatus !== false && realtimeStatusFingerprint(candidate) !== realtimeStatusFingerprint(document)) {
      throw new RealtimeWriteRejected("Realtime document status is written by the server.")
    }
    if (Y.encodeStateAsUpdate(candidate).byteLength > (options.maxStateBytes ?? maxRoomStateBytes)) {
      throw realtimeErrorDiagnostics.REALTIME_DOCUMENT_TOO_LARGE()
    }
  }
  finally {
    candidate.destroy()
  }
  return apply(document)
}

export function assertRealtimeRoomStateQuota(document: Y.Doc, maxStateBytes = maxRoomStateBytes): void {
  if (Y.encodeStateAsUpdate(document).byteLength > maxStateBytes) {
    throw new HTTPError({ status: 413, message: "Realtime document exceeds its 8 MiB room quota." })
  }
}

export function realtimeRoomKey(definitionName: string, documentId: string, scope?: string): string {
  // The scope is its own element, so no room id can name another person's room.
  return JSON.stringify(scope === undefined ? [definitionName, documentId] : [definitionName, documentId, scope])
}

/** The scope of a person's rooms in a Definition with `scope: "user"`, or `undefined` for shared rooms. */
function roomScope(definition: RealtimeDefinition, user: string | null): string | undefined {
  if (definition.document !== false || definition.scope !== "user") return undefined
  return user === null ? "anonymous" : `user:${user}`
}

export async function restoreRealtimeDocument(
  markdown: string,
  baselineDigest: string | undefined,
  stored: Record<string, unknown> | undefined,
): Promise<Y.Doc> {
  const update = storedUpdate(stored?.update_blob)
  const storedDigest = typeof stored?.baseline_digest === "string" ? stored.baseline_digest : undefined
  if (!update || storedDigest !== baselineDigest) {
    return await createRealtimeYDoc(realtimeMarkdownEditor, { body: markdown })
  }
  const document = new Y.Doc()
  try {
    Y.applyUpdate(document, update)
    return document
  }
  catch (error) {
    document.destroy()
    throw error
  }
}

function storedUpdate(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    try {
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
      const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get
      const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get
      const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get
      let buffer: ArrayBuffer
      let byteOffset: number
      let byteLength: number
      try {
        buffer = typedBuffer!.call(value)
        byteOffset = typedOffset!.call(value)
        byteLength = typedLength!.call(value)
      }
      catch {
        const dataViewPrototype = DataView.prototype
        buffer = Object.getOwnPropertyDescriptor(dataViewPrototype, "buffer")!.get!.call(value)
        byteOffset = Object.getOwnPropertyDescriptor(dataViewPrototype, "byteOffset")!.get!.call(value)
        byteLength = Object.getOwnPropertyDescriptor(dataViewPrototype, "byteLength")!.get!.call(value)
      }
      if (!buffer || byteOffset === undefined || byteLength === undefined) return undefined
      return new Uint8Array(buffer, byteOffset, byteLength)
    }
    catch {
      return undefined
    }
  }
  try {
    // The native getter checks the ArrayBuffer internal slot and accepts buffers from other realms.
    const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
    if (byteLength?.call(value) !== undefined) {
      return new Uint8Array(value as ArrayBuffer)
    }
  }
  catch {
    return undefined
  }
}

interface ResolvedRealtimeDefinition {
  adapter: RealtimeDocumentAdapter
  definition: RealtimeDocumentDefinition
  /** The codec of one document: the definition's editor, or the one its editor function picks. */
  editor: (context: RealtimeDocumentContext) => RealtimeEditor
  persistence: { debounce: number, maxWait: number } | false
}

const resolvedDefinitions = new WeakMap<RealtimeDocumentDefinition, ResolvedRealtimeDefinition>()

function isDocumentAdapter(document: RealtimeDocumentDefinition["document"]): document is RealtimeDocumentAdapter {
  return "load" in document && "save" in document
}

function duration(value: unknown, fallback: number, name: "debounce" | "maxWait"): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw realtimeErrorDiagnostics.REALTIME_INVALID_PERSISTENCE({ name, reason: "not-milliseconds" })
  }
  return value
}

/** Resolves the document adapter, editor codec, and persistence timing of a definition. */
export function resolveRealtimeDefinition(definition: RealtimeDocumentDefinition): ResolvedRealtimeDefinition {
  const cached = resolvedDefinitions.get(definition)
  if (cached) return cached
  assertRealtimeCheckpoint(definition)
  const document = definition.document
  const adapter = isDocumentAdapter(document) ? document : workspaceDocument(document.workspace)
  const persistence = definition.persistence === false
    ? false as const
    : {
        debounce: duration(definition.persistence?.debounce, realtimePersistenceDefaults.debounce, "debounce"),
        maxWait: duration(definition.persistence?.maxWait, realtimePersistenceDefaults.maxWait, "maxWait"),
      }
  if (persistence && persistence.maxWait < persistence.debounce) {
    throw realtimeErrorDiagnostics.REALTIME_INVALID_PERSISTENCE({ name: "maxWait", reason: "below-debounce" })
  }
  const configured = definition.editor ?? realtimeMarkdownEditor
  const editor = configured instanceof Function ? configured : () => configured
  const resolved = { adapter, definition, editor, persistence }
  resolvedDefinitions.set(definition, resolved)
  return resolved
}

interface RoomBase {
  awareness: awarenessProtocol.Awareness
  awarenessOwners: ReturnType<typeof createRealtimeAwarenessOwners>
  /** Shares the room with other instances. */
  bus?: RealtimeBus
  channel: string
  document: Y.Doc
  key: string
  peers: Set<WebSocketPeer>
}

/** A room without a document: the Workspace events room of a definition, or a room of a presence definition. */
interface EventsRoom extends RoomBase {
  kind: "events"
  /** The Workspace events room, which relays change hints. */
  workspace: boolean
}

interface DocumentRoom extends RoomBase {
  context: RealtimeDocumentContext
  destroyed: boolean
  digest: string | null
  dirty: boolean
  /** The editor codec of this document. */
  editor: RealtimeEditor
  editors: Map<string, RealtimeUser>
  /** Whether `adapter.hold()` kept the room, so the last leave calls `adapter.release()`. */
  held: boolean
  /** The status error of the last failed `adapter.hold()`, cleared by the next one that succeeds. */
  holdError?: string
  holdTimer?: ReturnType<typeof setInterval>
  /** Connected clients that may write. */
  writers: Set<WebSocketPeer>
  /** This instance holds the room lock of a shared room, so a reseed inside a save does not wait for it again. */
  locked?: boolean
  epoch: string
  firstDirtyAt?: number
  guard: DocumentGuard
  idleTimer?: ReturnType<typeof setTimeout>
  kind: "document"
  operations: number
  peerUsers: WeakMap<WebSocketPeer, RealtimeUser>
  persistedUpdates: number
  /** Gives a running saver time to publish its exact normalized result before treating a mismatch as external. */
  pendingRecovery?: { digest: string | null, since: number }
  queue: Promise<void>
  resolved: ResolvedRealtimeDefinition
  retryDelay: number
  revision: number
  /** A successful adapter save whose final shared record write still needs to complete. */
  unwrittenRecord?: RealtimeRoomRecord
  sql?: RealtimeRoomSql
}

type Room = DocumentRoom | EventsRoom

/** What the editor codec reported for the stored document, and the save that would change nothing. */
interface DocumentGuard {
  /** Body and fields whose save would leave the stored document as it is. */
  clean: { body: string, fields: Record<string, RealtimeFieldValue> }
  /** The stored body ends with a newline; saves keep it when the codec drops it. */
  finalNewline: boolean
  issues: RealtimeIssue[]
  /** `verify()` returned `writable: false`. */
  readOnly: boolean
}

async function verifyDocument(editor: RealtimeEditor, loaded: RealtimeLoadedDocument): Promise<DocumentGuard> {
  const result = await editor.verify?.(loaded.body, { fields: loaded.fields })
  const finalNewline = loaded.body.endsWith("\n")
  return {
    clean: { body: keepRealtimeFinalNewline(result?.canonical ?? loaded.body, finalNewline), fields: loadedFields(loaded) },
    finalNewline,
    issues: result?.issues ?? [],
    readOnly: result?.writable === false,
  }
}

function guardStatus(guard: DocumentGuard): { error: string | null, issues: RealtimeIssue[] } {
  return { error: guard.readOnly ? readOnlyDocumentMessage : null, issues: guard.issues }
}

function documentTables(sql: RealtimeRoomSql): boolean {
  sql.exec("CREATE TABLE IF NOT EXISTS vitehub_realtime_documents (room_key TEXT PRIMARY KEY, epoch TEXT NOT NULL, digest TEXT, dirty INTEGER NOT NULL, update_blob BLOB NOT NULL, editor_version TEXT)")
  try {
    sql.exec("ALTER TABLE vitehub_realtime_documents ADD COLUMN editor_version TEXT")
  }
  catch {
    // A new table already has the column. A host that rejects ALTER TABLE keeps the five-column table: its rooms read
    // as unversioned, so they restore only for an editor without `version`.
  }
  sql.exec("CREATE TABLE IF NOT EXISTS vitehub_realtime_document_updates (sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_key TEXT NOT NULL, update_blob BLOB NOT NULL, client_update INTEGER NOT NULL DEFAULT 1)")
  // Older adapter-era deployments already have this table without the client_update
  // column. SQLite keeps CREATE TABLE IF NOT EXISTS as a no-op in that case, so
  // explicitly add the column before any journal inserts.
  try {
    sql.exec("ALTER TABLE vitehub_realtime_document_updates ADD COLUMN client_update INTEGER NOT NULL DEFAULT 1")
    return true
  }
  catch {
    // A newly-created table already has the column, but some hosts reject every
    // ALTER TABLE statement. Probe the schema so that this case is not treated
    // like an older two-column journal.
    try {
      sql.exec("SELECT client_update FROM vitehub_realtime_document_updates LIMIT 0").toArray()
      return true
    }
    catch {
      // The column is genuinely unavailable; retain the two-column fallback.
      return false
    }
  }
}

/** Copy the pre-adapter Durable Object journal before reading the new schema. */
function migrateLegacyDocument(sql: RealtimeRoomSql, key: string, clientUpdateColumn: boolean): void {
  if (sql.exec("SELECT room_key FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray().length) return
  let legacy: Record<string, unknown> | undefined
  try {
    legacy = sql.exec("SELECT baseline_digest, update_blob FROM vitehub_realtime_rooms WHERE room_key = ?", key).toArray()[0]
  }
  catch {
    // Existing deployments without the legacy tables need no migration.
  }
  if (!legacy) return
  let updates: Array<Record<string, unknown>> = []
  try {
    updates = sql.exec("SELECT update_blob FROM vitehub_realtime_updates WHERE room_key = ? ORDER BY sequence", key).toArray()
  }
  catch {
    // The first release could persist the snapshot without creating its journal.
  }
  const update = storedUpdate(legacy.update_blob)
  if (!update) return
  sql.exec(
    "INSERT INTO vitehub_realtime_documents (room_key, epoch, digest, dirty, update_blob) VALUES (?, ?, ?, ?, ?)",
    key,
    crypto.randomUUID(),
    text(legacy.baseline_digest) ?? null,
    updates.length ? 1 : 0,
    Uint8Array.from(update).buffer,
  )
  for (const row of updates) {
    const legacyUpdate = storedUpdate(row.update_blob)
    if (!legacyUpdate) continue
    const blob = Uint8Array.from(legacyUpdate).buffer
    try {
      if (!clientUpdateColumn) throw new Error("client_update column unavailable")
      sql.exec(
        "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob, client_update) VALUES (?, ?, 1)",
        key,
        blob,
      )
    }
    catch {
      // Hosts that reject ALTER TABLE may still expose the intermediate
      // two-column journal schema. Preserve those rows so the room can open.
      sql.exec(
        "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob) VALUES (?, ?)",
        key,
        blob,
      )
    }
  }
}

function readStoredRoom(sql: RealtimeRoomSql, key: string): Record<string, unknown> | undefined {
  try {
    return sql.exec("SELECT epoch, digest, dirty, update_blob, editor_version FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray()[0]
  }
  catch {
    // The host rejected the editor_version column (see documentTables).
    return sql.exec("SELECT epoch, digest, dirty, update_blob FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray()[0]
  }
}

function parseRoomPath(url: string): { definitionName: string, documentId: string, searchParams: URLSearchParams, workspaceEvents: boolean } {
  const parsed = new URL(url)
  const path = parsed.pathname
  // Nitro may leave the app base on the request URL. The registered route already owns that prefix.
  const at = path.indexOf(routePrefix)
  if (at === -1) throw new HTTPError({ status: 404 })
  let parts: string[]
  try {
    parts = path.slice(at + routePrefix.length).split("/").map(decodeURIComponent)
  }
  catch {
    throw new HTTPError({ status: 400, message: "Realtime route components must be valid URL encoding." })
  }
  const [definitionName, ...documentParts] = parts
  if (!definitionName || documentParts.length === 0 || documentParts.some(part => !part)) {
    throw new HTTPError({ status: 400, message: "Realtime definition and document path are required." })
  }
  const documentId = documentParts.join("/")
  let safePath: string | undefined
  try {
    safePath = normalizeSafeWorkspacePath(documentId)
  }
  catch {}
  if (safePath !== documentId) {
    throw new HTTPError({ status: 400, message: "Realtime document paths must be safe Workspace paths." })
  }
  return {
    definitionName,
    documentId,
    searchParams: parsed.searchParams,
    workspaceEvents: parsed.searchParams.get("workspace") === "events",
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function toRealtimeUser(value: unknown): RealtimeUser | null {
  if (!value || !(value instanceof Object) || !("id" in value)) return null
  const id = text(value.id)
  if (!id) return null
  const user: RealtimeUser = { id }
  const name = "name" in value ? text(value.name) : undefined
  const email = "email" in value ? text(value.email) : undefined
  const image = "image" in value ? text(value.image) : undefined
  if (name) user.name = name
  if (email) user.email = email
  if (image) user.image = image
  return user
}

async function identify(request: Request, event: H3Event, definitionName: string, definition: RealtimeDefinition): Promise<RealtimeUser | null> {
  if (definition.identify) {
    const origin = request.headers.get("origin")
    // Browsers send Origin on WebSocket handshakes and POSTs. Reject cross-site use of ambient credentials.
    // A TLS-terminating proxy reports the client scheme and host in X-Forwarded-* headers. A page cannot set these
    // headers on a WebSocket handshake, so a cross-site page still cannot make its Origin match.
    // `origins` lets other origins in for definitions whose identify() reads a credential the page sends.
    if (origin && origin !== forwardedRequestOrigin(request) && !(await definition.origins?.({ definition: definitionName, event, origin, request }))) {
      throw new HTTPError({ status: 403, message: "Realtime requests must come from the application origin." })
    }
    const user = toRealtimeUser(await definition.identify({ definition: definitionName, event, request }))
    if (definition.auth && !user) throw new HTTPError({ status: 401 })
    return user
  }
  // A Definition with `scope: "user"` reads the Auth session when the app has one, and needs none.
  const optional = !definition.auth && definition.document === false && definition.scope === "user"
  if (!definition.auth && !optional) return null
  let auth
  try {
    auth = await assertAuthOrigin(request, event)
  }
  catch (error) {
    if (optional && isMissingAuth(error)) return null
    throw new HTTPError({ status: 403 })
  }
  const session = await auth.api.getSession({ headers: request.headers })
  const user = toRealtimeUser(session?.user)
  if (!user && !optional) throw new HTTPError({ status: 401 })
  return user
}

/** The app has no Auth Definition (`AUTH_R0005`), so nobody is signed in. */
function isMissingAuth(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "AUTH_R0005"
}

async function allows(
  definition: RealtimeDefinition,
  context: RealtimeAuthorizeContext,
): Promise<boolean> {
  if (!definition.authorize) return true
  return (await definition.authorize(context)) !== false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return "The realtime document could not be saved."
}

/** Refreshes the open room of one document in this process. Resolves whether the room re-seeded. */
type LocalRefresh = (definitionName: string, documentId: string) => Promise<boolean>
type LocalRefreshRef = WeakRef<LocalRefresh>

const localRefreshKey: unique symbol = Symbol.for("vitehub.realtime.local-refresh")
// SAFETY: This module owns the process slot shared by separately bundled handlers and callers.
const refreshScope = globalThis as typeof globalThis & { [localRefreshKey]?: Set<LocalRefreshRef> }

function localRefreshers(): Set<LocalRefreshRef> {
  refreshScope[localRefreshKey] ??= new Set()
  return refreshScope[localRefreshKey]
}

export interface RealtimeRefreshOptions {
  /**
   * On Cloudflare, the `$DurableObject` binding that holds the rooms. Defaults to the binding of the running Worker.
   * Without one, the rooms of this process refresh.
   */
  durableObjects?: RealtimeDurableObjectNamespace
}

/**
 * Tells the open room of a document that its stored copy changed outside the room, such as a save by an Agent or the
 * CLI. A room without unsaved edits re-seeds at once and resets its clients. A room with unsaved edits finds the change
 * at its next save, which also re-seeds it. A room that is not open loads the stored copy when it opens. Resolves
 * whether a room re-seeded. It never throws: a failed refresh leaves the next save to find the change.
 */
export async function refreshRealtimeDocument(definition: string, documentId: string, options: RealtimeRefreshOptions = {}): Promise<boolean> {
  const binding = options.durableObjects ?? workerDurableObjects()
  if (binding) return await refreshDurableRoom(binding, definition, documentId)
  let reseeded = false
  for (const reference of localRefreshers()) {
    const refresh = reference.deref()
    if (!refresh) {
      localRefreshers().delete(reference)
      continue
    }
    try {
      if (await refresh(definition, documentId)) reseeded = true
    }
    catch {
      // The next save of that room finds the change.
    }
  }
  return reseeded
}

/**
 * On Cloudflare the rooms belong to the Durable Object, even when it shares an isolate with the Worker that calls this.
 * Only the Durable Object may refresh them: from the Worker's request, a room's sockets cannot receive the reset.
 */
async function refreshDurableRoom(binding: RealtimeDurableObjectNamespace, definition: string, documentId: string): Promise<boolean> {
  try {
    const room = documentId.split("/").map(encodeURIComponent).join("/")
    const response = await binding.get(binding.idFromName(durableRoomsInstance)).fetch(new Request(
      `https://vitehub.internal${routePrefix}${encodeURIComponent(definition)}/${room}?document=refresh`,
      { method: "POST", headers: { [internalRefreshHeader]: "1" } },
    ))
    const result: unknown = response.ok ? await response.json() : undefined
    return result instanceof Object && "reseeded" in result && result.reseeded === true
  }
  catch {
    return false
  }
}

/**
 * A rejected upgrade keeps its status, and carries crossws hooks that refuse the socket. Without hooks, crossws (and
 * Nitro's adapters) still upgrade the request into a socket that never answers.
 */
function refuseUpgrade(request: Request, status: number): Response {
  const hooks: Partial<WebSocketHooks> = { upgrade: () => new Response(null, { status }) }
  // The same places h3's defineWebSocketHandler leaves hooks for adapters.
  const target = request as Request & { context?: Record<symbol, unknown>, [webSocketHooksKey]?: Partial<WebSocketHooks> }
  target[webSocketHooksKey] = hooks
  if (target.context) target.context[webSocketHooksKey] = hooks
  return Object.assign(new Response(null, { status }), { crossws: hooks })
}

const webSocketHooksKey = Symbol.for("crossws.hooks")

/** A request with no headers at all, like the stub that crossws restores a hibernated socket's peer with. Browsers always send some. */
function isBareRequest(request: Request): boolean {
  return request.headers.keys().next().done === true
}

export function createRealtimeHandler(registry: RealtimeRegistry, options: RealtimeHandlerOptions = {}): RealtimeHandler {
  const inactiveMemoryRoomKeys = new Set<string>()
  const memoryRoomKeys = new Set<string>()
  const rooms = new Map<string, Promise<Room>>()
  const peerAwarenessQueryAt = new WeakMap<WebSocketPeer, number>()
  const peerAwarenessUpdateAt = new WeakMap<WebSocketPeer, number>()
  const peerPendingAwareness = new WeakMap<WebSocketPeer, { timer: ReturnType<typeof setTimeout>, update: Uint8Array }>()
  const peerWorkspaceChanges = new WeakMap<WebSocketPeer, { count: number, startedAt: number }>()
  const peerInitialSyncStep2 = new WeakSet<WebSocketPeer>()
  const peerSyncUpdates = new WeakMap<WebSocketPeer, { at: number, tokens: number }>()
  const peerHeldUpdates = new WeakMap<WebSocketPeer, { bytes: number, timer: ReturnType<typeof setTimeout>, updates: Uint8Array[] }>()
  const terminalPeers = new WeakSet<WebSocketPeer>()
  function clearHeldUpdates(peer: WebSocketPeer): void {
    const held = peerHeldUpdates.get(peer)
    if (!held) return
    peerHeldUpdates.delete(peer)
    clearTimeout(held.timer)
  }

  let pendingBus: Promise<RealtimeBus | undefined> | undefined
  /** Rooms that finished opening, by key. */
  const openRooms = new Map<string, Room>()
  /** One owner object per other instance, for the awareness clients of its peers. */
  const remoteOwners = new Map<string, object>()
  const repairRequestedAt = new WeakMap<Room, number>()
  const syncing = new WeakSet<Room>()

  /** The bus that shares rooms with other instances, connected and subscribed on first use. */
  function sharedBus(): Promise<RealtimeBus | undefined> {
    if (!options.bus) return Promise.resolve(undefined)
    if (pendingBus) return pendingBus
    const connect = options.bus
    const pending = (async () => {
      const bus = await connect()
      if (!bus) return undefined
      await bus.subscribe(receive, () => {
        // The bus may have lost messages while it was down: ask the other instances for what each room lacks.
        for (const room of rooms.values()) room.then(requestSync, () => {})
      })
      bus.onClose(announceDeparture)
      // Pub/sub can also lose a single message without reconnecting, including the last edit in a room.
      const syncTimer = setInterval(() => {
        for (const room of openRooms.values()) {
          if (room.peers.size || (room.kind === "document" && room.dirty)) requestSync(room)
        }
      }, 10_000)
      syncTimer.unref?.()
      bus.onClose(async () => { clearInterval(syncTimer) })
      return bus
    })()
    pendingBus = pending
    pending.catch(() => {
      if (pendingBus === pending) pendingBus = undefined
    })
    return pending
  }

  function roomEpoch(room: Room): string {
    return room.kind === "document" ? room.epoch : eventsEpoch
  }

  function publish(room: Room, type: RealtimeBusMessageType, data: Uint8Array): void {
    room.bus?.publish({ type, room: room.key, epoch: roomEpoch(room), data }).catch((error: unknown) => {
      console.error("[vitehub] Realtime could not send a room message to the other instances.", error)
    })
  }

  /** Asks the other instances for the document updates and the presence that this room lacks. */
  function requestSync(room: Room): void {
    if (!room.bus) return
    if (room.kind !== "document") {
      publish(room, "sync", new Uint8Array())
      return
    }
    if (room.destroyed || syncing.has(room)) return
    // A newly opened clean room has not attached its first peer yet. Do not queue an operation that could release it.
    if (!room.peers.size && !room.dirty) {
      publish(room, "sync", Y.encodeStateVector(room.document))
      return
    }
    syncing.add(room)
    // The sender of a reset may have stopped. Reconcile with the record even when no other room answers the sync.
    enqueue(room, async () => {
      const record = await room.bus?.readRoom(room.key)
      if (room.destroyed) return
      if (record && record.epoch !== room.epoch) await reseedRoom(room, "source-changed", undefined, false, true)
      if (!room.destroyed) publish(room, "sync", Y.encodeStateVector(room.document))
    }).catch((error: unknown) => {
      console.error("[vitehub] Realtime could not repair a shared room.", error)
    }).finally(() => syncing.delete(room))
  }

  /** Awareness clients of this instance's peers. */
  function localAwarenessClients(room: RoomBase): number[] {
    return knownAwarenessClients(room.awareness, [...room.awareness.getStates().keys()].filter(client => room.awarenessOwners.ownsLocally(client)))
  }

  /** Tells the other instances that the peers of this instance left, before the bus closes. */
  async function announceDeparture(): Promise<void> {
    const sent: Array<Promise<void>> = []
    for (const pending of rooms.values()) {
      const room = await pending.catch(() => undefined)
      if (!room?.bus) continue
      const clients = localAwarenessClients(room)
      if (!clients.length) continue
      // A null state at the current clock removes the client on the other instances.
      const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients, new Map())
      sent.push(room.bus.publish({ type: "awareness", room: room.key, epoch: roomEpoch(room), data: update }))
    }
    await Promise.allSettled(sent)
  }

  function remoteOwner(instance: string): object {
    let owner = remoteOwners.get(instance)
    if (!owner) remoteOwners.set(instance, owner = { instance })
    return owner
  }

  /**
   * Applies a message from another instance to the open room it names. A room that is still opening skips the
   * message: it asks for what it lacks when it opens.
   */
  function receive(message: RealtimeBusMessage): void {
    if (message.type === "refresh") {
      const key: unknown = JSON.parse(message.room)
      const [definitionName, documentId]: unknown[] = Array.isArray(key) ? key : []
      if (typeof definitionName === "string" && typeof documentId === "string") refreshOpenRoom(definitionName, documentId, false).catch(() => {})
      return
    }
    if (message.type === "reset") {
      // Also a room that is opening: it may have read the record before the reset.
      rooms.get(message.room)?.then((room) => {
        if (room.kind !== "document" || !room.bus || room.destroyed || room.epoch === message.epoch) return
        enqueue(room, async () => {
          if (room.epoch !== message.epoch) await reseedRoom(room, "source-changed", undefined, false, true)
        }).catch(() => {})
      }, () => {})
      return
    }
    const room = openRooms.get(message.room)
    if (!room?.bus || (room.kind === "document" && room.destroyed)) return
    // Updates from another Yjs history would duplicate the document.
    if (message.epoch !== roomEpoch(room)) {
      if (message.type === "sync") requestSync(room)
      return
    }
    switch (message.type) {
      case "update":
        if (room.kind === "document") {
          Y.applyUpdate(room.document, message.data, busOrigin)
          if ((room.document.store.pendingStructs || room.document.store.pendingDs)
            && Date.now() - (repairRequestedAt.get(room) ?? -Infinity) >= 1_000) {
            repairRequestedAt.set(room, Date.now())
            requestSync(room)
          }
        }
        return
      case "claim": {
        try {
          const client = decoding.readVarUint(decoding.createDecoder(message.data))
          room.awarenessOwners.claim(room.awareness, remoteOwner(message.instance), client, undefined, true)
        }
        catch { /* Ignore an invalid claim from another instance. */ }
        return
      }
      case "awareness": {
        let clients: number[]
        try {
          clients = room.awarenessOwners.apply(room.awareness, remoteOwner(message.instance), message.data, undefined, true)
        }
        catch {
          return
        }
        const known = knownAwarenessClients(room.awareness, clients)
        if (!known.length) return
        const frame = encodeAwarenessState(room.awareness, known)
        for (const peer of room.peers) peer.send(frame)
        return
      }
      case "sync": {
        if (room.kind === "document") {
          const missing = Y.encodeStateAsUpdate(room.document, message.data)
          if (missing.byteLength > emptyUpdateBytes) publish(room, "update", missing)
        }
        const clients = localAwarenessClients(room)
        if (clients.length) publish(room, "awareness", awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients))
        return
      }
      case "frame":
        for (const peer of room.peers) peer.send(message.data)
    }
  }

  /**
   * Relays the awareness changes that are not a peer's own message: clients that timed out, and clients that another
   * instance removed. Awareness removes a client 30 seconds after its last update, so the presence of an instance that
   * stopped without a goodbye expires on the others.
   */
  function watchAwareness(room: RoomBase): void {
    const awareness = room.awareness
    awareness.on("update", ({ removed }: { removed: number[] }, origin: unknown) => {
      if (room.awareness !== awareness || !removed.length) return
      room.awarenessOwners.releaseRemote(removed)
      if (origin !== "timeout") return
      const clients = knownAwarenessClients(awareness, removed)
      if (!clients.length) return
      const frame = encodeAwarenessState(awareness, clients)
      for (const peer of room.peers) peer.send(frame)
    })
  }

  /** The Cloudflare bindings and execution context, or the Durable Object state, in the event's Standard Context. */
  function resolveCloudflare(event: H3Event): { context?: unknown, env?: unknown } | undefined {
    return getStandardContext(event).runtime?.cloudflare
  }

  async function forwardToCloudflareDurableObject(event: H3Event): Promise<Response | undefined> {
    const cloudflare = resolveCloudflare(event)
    const context = cloudflare?.context
    const binding = (cloudflare?.env as Record<string, unknown> | undefined)?.$DurableObject as {
      get(id: unknown): { fetch(request: Request): Promise<Response> }
      idFromName(name: string): unknown
    } | undefined
    if (!binding || !isRealtimeDurableObjectNamespace(binding) || (typeof context === "object" && context !== null && "storage" in context)) return
    let request = event.req
    if (request.headers.has(internalRefreshHeader) || request.headers.has(internalRequestHeader)) {
      // Only refreshRealtimeDocument() and requestRealtimeRoom() may send them, straight to the Durable Object.
      const headers = new Headers(request.headers)
      headers.delete(internalRefreshHeader)
      headers.delete(internalRequestHeader)
      request = new Request(request, { headers })
    }
    return await binding.get(binding.idFromName(durableRoomsInstance)).fetch(request)
  }

  function resolveRealtimeRoomSql(event: H3Event): RealtimeRoomSql | undefined {
    const context = resolveCloudflare(event)?.context
    if (!context || typeof context !== "object" || !Object.hasOwn(context, "storage")) return undefined
    const storageDescriptor = Object.getOwnPropertyDescriptor(context, "storage")
    if (!storageDescriptor || !("value" in storageDescriptor)) return undefined
    const storage = storageDescriptor.value
    if (!storage || typeof storage !== "object") return undefined
    const readNativeSql = (descriptor: PropertyDescriptor, inherited = false): RealtimeRoomSql | undefined => {
      if ("value" in descriptor) return !inherited && hasNativeCloudflareSql(descriptor.value) ? descriptor.value : undefined
      const getter = descriptor.get
      if (typeof getter !== "function") return undefined
      const source = Function.prototype.toString.call(getter)
      if (!/^function(?:\s+get(?:\s+\w+)?|\s+\w+)?\s*\(\s*\)\s*\{\s*\[native\s+code\]\s*\}$/.test(source)) return undefined
      try {
        const sql = Reflect.get(storage, "sql")
        return hasNativeCloudflareSql(sql) ? sql : undefined
      }
      catch { return undefined }
    }
    const descriptor = Object.getOwnPropertyDescriptor(storage, "sql")
    if (descriptor) return readNativeSql(descriptor)
    let prototype = Object.getPrototypeOf(storage)
    while (prototype && prototype !== Object.prototype) {
      const sqlDescriptor = Object.getOwnPropertyDescriptor(prototype, "sql")
      if (sqlDescriptor) return readNativeSql(sqlDescriptor, true)
      prototype = Object.getPrototypeOf(prototype)
    }
    return undefined
  }

  async function getDefinition(definitionName: string): Promise<RealtimeDefinition> {
    const loader = Object.hasOwn(registry, definitionName) ? registry[definitionName] : undefined
    const module = await loader?.()
    if (!module) throw new HTTPError({ status: 404, message: `Unknown realtime definition ${JSON.stringify(definitionName)}.` })
    return module.default
  }

  async function reserveMemoryRoom(): Promise<void> {
    if (memoryRoomKeys.size < maxMemoryRooms) return
    const inactiveKey = inactiveMemoryRoomKeys.values().next().value
    const inactive = inactiveKey ? await rooms.get(inactiveKey)?.catch(() => undefined) : undefined
    if (
      inactive
      && inactiveMemoryRoomKeys.has(inactive.key)
      && inactive.peers.size === 0
      && (inactive.kind === "events" || (inactive.operations === 0 && !inactive.dirty))
    ) {
      destroyRoom(inactive)
    }
    if (memoryRoomKeys.size >= maxMemoryRooms) {
      throw new HTTPError({ status: 503, message: "The in-memory realtime authority reached its active room limit." })
    }
  }

  async function openRoom<T extends Room>(key: string, sql: RealtimeRoomSql | undefined, create: () => Promise<T>): Promise<T> {
    // SAFETY: Room keys are namespaced by kind: document keys are [definition, path] and event keys carry { workspaceEvents }.
    let room = rooms.get(key) as Promise<T> | undefined
    if (!room && !sql) {
      await reserveMemoryRoom()
      // SAFETY: Room keys are namespaced by kind, as above.
      room = rooms.get(key) as Promise<T> | undefined
    }
    if (!room) {
      if (!sql) memoryRoomKeys.add(key)
      room = create()
      rooms.set(key, room)
      room.catch(() => {
        if (rooms.get(key) === room) rooms.delete(key)
        inactiveMemoryRoomKeys.delete(key)
        memoryRoomKeys.delete(key)
      })
    }
    const value = await room
    inactiveMemoryRoomKeys.delete(key)
    return value
  }

  function getEventsRoom(key: string, workspace: boolean, sql: RealtimeRoomSql | undefined): Promise<EventsRoom> {
    return openRoom(key, sql, async () => {
      const bus = await sharedBus()
      const document = new Y.Doc()
      const awareness = new awarenessProtocol.Awareness(document)
      awareness.setLocalState(null)
      const room: EventsRoom = {
        awareness,
        awarenessOwners: createRealtimeAwarenessOwners(),
        bus,
        channel: `vitehub:realtime:${key}`,
        document,
        key,
        kind: "events",
        peers: new Set(),
        workspace,
      }
      watchAwareness(room)
      openRooms.set(key, room)
      requestSync(room)
      return room
    })
  }

  function createAwareness(document: Y.Doc): awarenessProtocol.Awareness {
    const awareness = new awarenessProtocol.Awareness(document)
    awareness.setLocalState(null)
    return awareness
  }

  function roomPeer(room: RoomBase, origin: unknown): WebSocketPeer | undefined {
    for (const peer of room.peers) {
      if (peer === origin) return peer
    }
  }

  function listen(room: DocumentRoom, document: Y.Doc): void {
    document.on("update", (update: Uint8Array, origin: unknown, _document: Y.Doc, transaction: Y.Transaction) => {
      if (room.document !== document) return
      persistRoomUpdate(room, update, origin !== serverOrigin)
      const message = encodeSyncUpdate(update)
      const sender = roomPeer(room, origin)
      if (sender) sender.publish(room.channel, message)
      else for (const peer of room.peers) peer.send(message)
      if (origin === busOrigin) {
        // Another instance saves its own status. Its edits make this room dirty too, so a save here loses nothing if
        // that instance stops.
        if (!changesOnlyStatus(document, transaction)) markDirty(room, undefined)
        return
      }
      publish(room, "update", update)
      if (origin !== serverOrigin) markDirty(room, sender && room.peerUsers.get(sender))
    })
  }

  function replaceDocument(room: DocumentRoom, document: Y.Doc): void {
    room.document = document
    room.awareness = createAwareness(document)
    room.awarenessOwners = createRealtimeAwarenessOwners()
    watchAwareness(room)
    listen(room, document)
  }

  /**
   * The document of a shared room: the shared record when it holds the stored digest, else a new seed that becomes the
   * record. Instances that open a room at the same time agree on one record, so every instance edits one Yjs history.
   * `replaced` is true when this instance moved the record to a new epoch.
   */
  async function sharedDocument(bus: RealtimeBus, key: string, editor: RealtimeEditor, loaded: RealtimeLoadedDocument, guard: DocumentGuard): Promise<{ document: Y.Doc, epoch: string, replaced: boolean, dirty?: boolean }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const found = await bus.readRoom(key)
      const record = found && await recoverSharedRecord(bus, key, editor, loaded, found)
      if (record && record.digest === loaded.digest) {
        const document = new Y.Doc()
        try {
          Y.applyUpdate(document, record.state)
          if (readRealtimeStatus(document).digest !== record.digest) writeRealtimeStatus(document, { digest: record.digest }, serverOrigin)
          return { document, epoch: record.epoch, replaced: false, dirty: record.pending }
        }
        catch (error) {
          document.destroy()
          throw error
        }
      }
      const document = await seedDocument(editor, loaded, guard)
      const epoch = crypto.randomUUID()
      if (await bus.writeRoom(key, { epoch, digest: loaded.digest, state: Y.encodeStateAsUpdate(document) }, record?.epoch ?? null)) {
        return { document, epoch, replaced: !!record }
      }
      // Another instance wrote the record first. Read it again.
      document.destroy()
    }
    throw new HTTPError({ status: 503, message: "Realtime instances changed this room at the same time. Connect again." })
  }

  /** All callers hold the room lock. Never report a save as clean when its record was not written. */
  async function writeSharedRecord(bus: RealtimeBus, key: string, record: RealtimeRoomRecord): Promise<void> {
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (await bus.writeRoom(key, record, record.epoch)) return
        console.error("[vitehub] Realtime room record compare-and-set failed.", key)
        // Internal invariant: compare-and-set rejection is caught here and retried before the room save reports failure.
        throw new Error("Realtime room record compare-and-set failed.")
      }
      catch (error) { failure = error }
    }
    console.error("[vitehub] Realtime could not write the shared room record.", failure)
    throw failure
  }

  /** A process can stop between adapter.save() and the final record write. Recover that save without a new epoch. */
  async function recoverSharedRecord(bus: RealtimeBus, key: string, editor: RealtimeEditor, loaded: RealtimeLoadedDocument, record: RealtimeRoomRecord): Promise<RealtimeRoomRecord> {
    if (!record.pending || loaded.digest === record.digest) return record
    const submitted = new Y.Doc()
    try {
      Y.applyUpdate(submitted, record.state)
      const snapshot = await readRealtimeYDoc(editor, submitted)
      if (keepRealtimeFinalNewline(snapshot.body, loaded.body.endsWith("\n")) !== loaded.body
        || !realtimeJsonEqual(snapshot.fields, loadedFields(loaded))) return record
      writeRealtimeStatus(submitted, { digest: loaded.digest, error: null }, serverOrigin)
      const recovered = { ...record, digest: loaded.digest, state: Y.encodeStateAsUpdate(submitted), pending: false }
      await writeSharedRecord(bus, key, recovered)
      return recovered
    }
    finally { submitted.destroy() }
  }

  /**
   * Takes the saves of other instances into a shared room before it saves: their Yjs state, their digest, and the
   * stored form that a save with no edits keeps. Returns `false` when the room re-seeded on another instance, after
   * this room followed it.
   */
  async function adoptSharedRecord(room: DocumentRoom, bus: RealtimeBus): Promise<boolean> {
    let record = await bus.readRoom(room.key)
    let pendingLoaded: RealtimeLoadedDocument | undefined
    if (!record) return true
    if (record.epoch !== room.epoch) {
      room.unwrittenRecord = undefined
      await reseedRoom(room, "source-changed", undefined, false, true)
      return false
    }
    const unwritten = room.unwrittenRecord
    if (unwritten) {
      const saved = new Y.Doc()
      try {
        Y.applyUpdate(saved, unwritten.state)
        // Another instance may already have recovered or advanced the record. Never replace a newer pending save
        // with our older result. A readback digest, rather than body equality, also covers adapter normalization.
        if (record.pending && unwritten.epoch === record.epoch && containsRealtimeState(saved, record.state)) {
          const loaded = await room.resolved.adapter.load(room.context)
          if (loaded.digest === unwritten.digest) {
            await writeSharedRecord(bus, room.key, unwritten)
            record = unwritten
          }
        }
        room.unwrittenRecord = undefined
      }
      finally { saved.destroy() }
    }
    if (record.pending) {
      const loaded = await room.resolved.adapter.load(room.context)
      pendingLoaded = loaded
      record = await recoverSharedRecord(bus, room.key, room.editor, loaded, record)
      if (record.digest !== loaded.digest) {
        if (room.pendingRecovery?.digest !== loaded.digest) room.pendingRecovery = { digest: loaded.digest, since: Date.now() }
        if (Date.now() - room.pendingRecovery.since < 10_000) {
          throw new HTTPError({ status: 503, message: "Realtime is waiting for another instance to finish its interrupted save. Retry the save." })
        }
        await reseedRoom(room, "source-changed", loaded)
        return false
      }
    }
    room.pendingRecovery = undefined
    const sameStored = record.digest === room.digest && !record.pending
    const saved = new Y.Doc()
    try {
      Y.applyUpdate(saved, record.state)
      const stored = record.pending && pendingLoaded
        ? { body: pendingLoaded.body, fields: loadedFields(pendingLoaded) }
        : await readRealtimeYDoc(room.editor, saved)
      if (room.destroyed || room.epoch !== record.epoch) return false
      Y.applyUpdate(room.document, record.state, busOrigin)
      room.digest = record.digest
      if (readRealtimeStatus(room.document).digest !== record.digest) writeRealtimeStatus(room.document, { digest: record.digest }, serverOrigin)
      if (sameStored) return true
      room.guard = {
        clean: { body: keepRealtimeFinalNewline(stored.body, room.guard.finalNewline), fields: stored.fields },
        finalNewline: room.guard.finalNewline,
        issues: [],
        readOnly: false,
      }
      if (record.pending) markDirty(room, undefined)
      return true
    }
    finally {
      saved.destroy()
    }
  }

  async function seedDocument(editor: RealtimeEditor, loaded: RealtimeLoadedDocument, guard: DocumentGuard): Promise<Y.Doc> {
    const document = await createRealtimeYDoc(editor, loaded)
    writeRealtimeStatus(document, { digest: loaded.digest, ...guardStatus(guard), savedAt: null, savedBy: null }, serverOrigin)
    assertRealtimeRoomStateQuota(document)
    return document
  }

  function getDocumentRoom(definitionName: string, documentId: string, resolved: ResolvedRealtimeDefinition, sql: RealtimeRoomSql | undefined): Promise<DocumentRoom> {
    const key = realtimeRoomKey(definitionName, documentId)
    return openRoom(key, sql, async () => {
      const bus = sql ? undefined : await sharedBus()
      const context: RealtimeDocumentContext = { authority: sql ? "cloudflare" : bus?.authority ?? "memory", definition: definitionName, documentId }
      const editor = resolved.editor(context)
      // A shared room loads the document and reads the record under the room lock, so no save of another instance
      // runs in between: a digest that differs from the record then means a change outside the room.
      const { loaded, guard, shared } = bus
        ? await bus.withRoomLock(key, async () => {
            const loaded = await resolved.adapter.load(context)
            const guard = await verifyDocument(editor, loaded)
            return { loaded, guard, shared: await sharedDocument(bus, key, editor, loaded, guard) }
          })
        : await (async () => {
            const loaded = await resolved.adapter.load(context)
            return { loaded, guard: await verifyDocument(editor, loaded), shared: undefined }
          })()
      if (sql) {
        const clientUpdateColumn = documentTables(sql)
        migrateLegacyDocument(sql, key, clientUpdateColumn)
      }
      const stored = sql && readStoredRoom(sql, key)
      const storedDigest = text(stored?.digest) ?? null
      const storedEpoch = text(stored?.epoch)
      const storedState = storedUpdate(stored?.update_blob)
      // Restore persisted Yjs state while it still describes the stored document. A different
      // digest means an external write: seed a new room so stale client state cannot merge back.
      // A different editor version means a schema that may not read the old state: TipTap would
      // delete the nodes it does not know from the room, so seed from the Markdown instead.
      const restores = !!sql && !!storedState && !!storedEpoch && storedDigest === loaded.digest
        && (text(stored?.editor_version) ?? null) === (editor.version ?? null)
      let document: Y.Doc
      let persistedUpdates = 0
      let dirty = false
      let refreshedFields = false
      let sharedEpoch: string | undefined
      let replacedEpoch = false
      if (shared) {
        document = shared.document
        sharedEpoch = shared.epoch
        replacedEpoch = shared.replaced
        dirty = shared.dirty ?? false
      }
      else if (restores) {
        document = new Y.Doc()
        try {
          Y.applyUpdate(document, storedState)
          let updates: Array<Record<string, unknown>>
          try {
            updates = sql.exec("SELECT update_blob, client_update FROM vitehub_realtime_document_updates WHERE room_key = ? ORDER BY sequence", key).toArray()
          }
          catch {
            updates = sql.exec("SELECT update_blob FROM vitehub_realtime_document_updates WHERE room_key = ? ORDER BY sequence", key).toArray()
          }
          for (const row of updates) {
            const update = storedUpdate(row.update_blob)
            if (update) Y.applyUpdate(document, update)
          }
          persistedUpdates = updates.length
          dirty = Number(stored?.dirty) === 1 || updates.some(update => update.client_update === undefined || Number(update.client_update) === 1)
          // A schema can read the same stored file differently, such as a string that now reads as an image
          // reference. A room without unsaved edits shows the fields as they load now.
          const fields = document.getMap(realtimeDocumentLayout.fields)
          if (!dirty && !holdsFields(fields, guard.clean.fields)) {
            document.transact(() => writeRealtimeFields(fields, guard.clean.fields), serverOrigin)
            refreshedFields = true
          }
          assertRealtimeRoomStateQuota(document)
          // The codec may have changed since the room was persisted: show what it reports now.
          if (guard.readOnly || readRealtimeStatus(document).error === readOnlyDocumentMessage) {
            writeRealtimeStatus(document, guardStatus(guard), serverOrigin)
          }
        }
        catch (error) {
          document.destroy()
          throw error
        }
      }
      else {
        document = await seedDocument(editor, loaded, guard)
      }
      const room: DocumentRoom = {
        awareness: createAwareness(document),
        awarenessOwners: createRealtimeAwarenessOwners(),
        bus,
        channel: `vitehub:realtime:${key}`,
        context,
        destroyed: false,
        digest: loaded.digest,
        document,
        dirty,
        editor,
        editors: new Map(),
        epoch: sharedEpoch ?? (restores && storedEpoch ? storedEpoch : crypto.randomUUID()),
        guard,
        held: false,
        writers: new Set(),
        key,
        kind: "document",
        operations: 0,
        peerUsers: new WeakMap(),
        peers: new Set(),
        persistedUpdates,
        queue: Promise.resolve(),
        resolved,
        retryDelay: 0,
        revision: 0,
        sql,
      }
      watchAwareness(room)
      listen(room, document)
      if (sql && (!restores || refreshedFields)) persistRoom(room)
      if (dirty) scheduleSave(room)
      openRooms.set(key, room)
      // Rooms of other instances at an older epoch follow this one.
      if (replacedEpoch) publish(room, "reset", new Uint8Array())
      requestSync(room)
      return room
    })
  }

  function persistRoom(room: DocumentRoom): void {
    if (!room.sql) return
    // ponytail: full snapshots keep recovery atomic; use compacted update logs when document write cost becomes measurable.
    const row = [room.key, room.epoch, room.digest, room.dirty ? 1 : 0, Uint8Array.from(Y.encodeStateAsUpdate(room.document)).buffer]
    try {
      room.sql.exec(
        "INSERT OR REPLACE INTO vitehub_realtime_documents (room_key, epoch, digest, dirty, update_blob, editor_version) VALUES (?, ?, ?, ?, ?, ?)",
        ...row,
        room.editor.version ?? null,
      )
    }
    catch {
      // The host rejected the editor_version column (see documentTables).
      room.sql.exec("INSERT OR REPLACE INTO vitehub_realtime_documents (room_key, epoch, digest, dirty, update_blob) VALUES (?, ?, ?, ?, ?)", ...row)
    }
    room.sql.exec("DELETE FROM vitehub_realtime_document_updates WHERE room_key = ?", room.key)
    room.persistedUpdates = 0
  }

  function persistRoomUpdate(room: DocumentRoom, update: Uint8Array, clientUpdate: boolean): void {
    if (!room.sql) return
    const blob = Uint8Array.from(update).buffer
    try {
      room.sql.exec(
        "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob, client_update) VALUES (?, ?, ?)",
        room.key,
        blob,
        clientUpdate ? 1 : 0,
      )
    }
    catch {
      // Some Durable Object SQLite versions reject ALTER TABLE on an existing
      // journal. Keep those deployments writable until the column can be
      // added; restored rows are treated as client updates by default.
      room.sql.exec(
        "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob) VALUES (?, ?)",
        room.key,
        blob,
      )
    }
    room.persistedUpdates++
    if (room.persistedUpdates >= durableUpdateCompactionInterval) persistRoom(room)
  }

  function destroyRoom(room: Room): void {
    if (room.kind === "document") {
      if (room.idleTimer) clearTimeout(room.idleTimer)
      room.idleTimer = undefined
      if (room.holdTimer) clearInterval(room.holdTimer)
      room.holdTimer = undefined
      room.destroyed = true
    }
    room.awareness.destroy()
    room.document.destroy()
    rooms.delete(room.key)
    if (openRooms.get(room.key) === room) openRooms.delete(room.key)
    inactiveMemoryRoomKeys.delete(room.key)
    memoryRoomKeys.delete(room.key)
  }

  /** Releases an idle room: durable rooms leave memory; clean memory rooms become reclaimable. */
  function releaseRoom(room: Room): void {
    if (room.peers.size > 0) return
    // A presence room has nothing to keep, and a Durable Object never reclaims rooms that it does not destroy.
    if (room.kind === "events" && (room.bus || !room.workspace)) {
      destroyRoom(room)
      return
    }
    if (room.kind === "events") {
      inactiveMemoryRoomKeys.delete(room.key)
      inactiveMemoryRoomKeys.add(room.key)
      return
    }
    if (room.operations > 0 || room.destroyed || room.held) return
    if (room.sql) {
      persistRoom(room)
      destroyRoom(room)
      return
    }
    // A shared room without unsaved edits opens again from its record and the other instances.
    if (room.bus && !room.dirty) {
      destroyRoom(room)
      return
    }
    // Keep dirty memory-only rooms resident: there is no durable destination
    // from which their unsaved edits could be recovered after eviction.
    if (room.dirty) return
    inactiveMemoryRoomKeys.delete(room.key)
    inactiveMemoryRoomKeys.add(room.key)
  }

  function enqueue<T>(room: DocumentRoom, operation: () => Promise<T>): Promise<T> {
    room.operations++
    const run = room.queue.then(() => {
      if (room.destroyed) throw new HTTPError({ status: 409, message: "The realtime room closed." })
      return operation()
    })
    room.queue = run.then(() => {}, () => {})
    return run.finally(() => {
      room.operations--
      releaseRoom(room)
    })
  }

  function markDirty(room: DocumentRoom, user: RealtimeUser | undefined): void {
    room.dirty = true
    room.revision++
    if (user) {
      room.editors.delete(user.id)
      room.editors.set(user.id, user)
    }
    scheduleSave(room)
  }

  /** Identified users of the writable clients, once each, in the order they joined. */
  function holdUsers(room: DocumentRoom): RealtimeUser[] {
    const users = new Map<string, RealtimeUser>()
    for (const peer of room.writers) {
      const user = room.peerUsers.get(peer)
      if (user && !users.has(user.id)) users.set(user.id, user)
    }
    return [...users.values()]
  }

  /** Calls `adapter.hold()` for a room with writable clients, such as to keep a lease, and repeats it every minute. */
  function holdRoom(room: DocumentRoom): void {
    const hold = room.resolved.adapter.hold
    if (!hold || room.destroyed || room.guard.readOnly) return
    if (room.writers.size === 0) {
      if (room.held) releaseHold(room)
      return
    }
    room.held = true
    room.holdTimer ??= setInterval(() => holdRoom(room), holdIntervalMs)
    enqueue(room, async () => {
      if (room.writers.size === 0) return
      try {
        await hold.call(room.resolved.adapter, room.context, { users: holdUsers(room) })
        if (room.holdError !== undefined && readRealtimeStatus(room.document).error === room.holdError) {
          writeRealtimeStatus(room.document, { error: null }, serverOrigin)
        }
        room.holdError = undefined
      }
      catch (error) {
        room.holdError = errorMessage(error)
        writeRealtimeStatus(room.document, { error: room.holdError }, serverOrigin)
      }
    }).catch(() => {})
  }

  /** After the last writable client left: save what is left, then call `adapter.release()`. */
  function releaseHold(room: DocumentRoom): void {
    if (room.holdTimer) clearInterval(room.holdTimer)
    room.holdTimer = undefined
    if (room.dirty && room.resolved.persistence) enqueue(room, () => saveRoom(room, "leave", false)).catch(() => {})
    enqueue(room, async () => {
      if (room.writers.size > 0 || !room.held) return
      room.held = false
      await room.resolved.adapter.release?.(room.context)
    }).catch(() => {
      room.held = false
    })
  }

  function scheduleSave(room: DocumentRoom, delay?: number): void {
    const persistence = room.resolved.persistence
    if (!persistence || room.destroyed || room.guard.readOnly) return
    const now = Date.now()
    room.firstDirtyAt ??= now
    if (room.idleTimer) clearTimeout(room.idleTimer)
    const wait = delay ?? Math.max(0, Math.min(persistence.debounce, room.firstDirtyAt + persistence.maxWait - now))
    room.idleTimer = setTimeout(() => {
      room.idleTimer = undefined
      enqueue(room, () => saveRoom(room, "idle", false)).catch(() => {})
    }, wait)
  }

  /** Runs `task` under the room lock of a shared room, or at once when this instance already holds it. */
  async function underRoomLock<T>(room: DocumentRoom, task: () => Promise<T>): Promise<T> {
    const bus = room.bus
    if (!bus || room.locked) return await task()
    return await bus.withRoomLock(room.key, async () => {
      room.locked = true
      try {
        return await task()
      }
      finally {
        room.locked = false
      }
    })
  }

  /**
   * `follow` re-seeds a shared room at the epoch that another instance moved its record to. It replaces the document
   * also after a concurrent edit: a room at an older epoch cannot reach the other instances.
   */
  async function reseedRoom(room: DocumentRoom, reason: RealtimeResetReason, loaded?: RealtimeLoadedDocument, preserveEdits = false, follow = false): Promise<boolean> {
    const revision = room.revision
    const stale = () => room.destroyed || (!follow && (room.revision !== revision || (preserveEdits && room.dirty)))
    let source: RealtimeLoadedDocument
    let guard: DocumentGuard
    let next: Y.Doc
    let epoch: string
    let replaced = false
    let dirty = false
    const bus = room.bus
    if (bus) {
      // Under the room lock, the load and the record agree unless the document changed outside the room.
      const shared = await underRoomLock(room, async () => {
        const source = loaded ?? await room.resolved.adapter.load(room.context)
        const guard = await verifyDocument(room.editor, source)
        if (stale()) return undefined
        return { source, guard, ...await sharedDocument(bus, room.key, room.editor, source, guard) }
      })
      if (!shared) return false
      ;({ source, guard, document: next, epoch, replaced } = shared)
      dirty = shared.dirty ?? false
      if (room.destroyed) {
        next.destroy()
        return false
      }
    }
    else {
      source = loaded ?? await room.resolved.adapter.load(room.context)
      guard = await verifyDocument(room.editor, source)
      next = await seedDocument(room.editor, source, guard)
      epoch = crypto.randomUUID()
    }
    // Verification and seeding are asynchronous. Preserve edits that arrive while they run.
    // A client update can arrive during verification or seeding. The revision
    // guard applies to every reseed, including conflict recovery, so that the
    // live document is never replaced after a concurrent edit.
    if (!room.bus && stale()) {
      next.destroy()
      return false
    }
    const previous = { awareness: room.awareness, document: room.document }
    const peers = [...room.peers]
    // Keep peers and writers tracked until their close callbacks run so the room is released when reset sockets close.
    room.epoch = epoch
    room.unwrittenRecord = undefined
    room.pendingRecovery = undefined
    room.digest = source.digest
    room.guard = guard
    room.dirty = dirty
    room.editors.clear()
    room.firstDirtyAt = undefined
    room.retryDelay = 0
    if (room.idleTimer) clearTimeout(room.idleTimer)
    room.idleTimer = undefined
    replaceDocument(room, next)
    previous.awareness.destroy()
    previous.document.destroy()
    persistRoom(room)
    if (dirty) scheduleSave(room)
    if (replaced) publish(room, "reset", new Uint8Array())
    // Edits that other instances made at this epoch before this room followed it.
    requestSync(room)
    const reset = encodeRealtimeControl({ type: "reset", epoch: room.epoch, reason })
    for (const peer of peers) {
      terminalPeers.add(peer)
      clearHeldUpdates(peer)
      peer.unsubscribe(room.channel)
      peer.send(reset)
      peer.close(realtimeResetCloseCode, "The realtime document was re-seeded.")
    }
    return true
  }

  /**
   * Saves of a shared room run one at a time across instances, under the room lock. Each first takes in the saves of
   * the other instances, so its `ifDigest` is the stored digest, unless the document changed outside the room. After
   * the save, the record holds the saved state and digest for the next instance.
   */
  async function saveRoom(room: DocumentRoom, reason: RealtimeSaveOptions["reason"], force: boolean): Promise<RealtimeSaved | undefined> {
    const bus = room.bus
    if (!bus) return await saveRoomNow(room, reason, force)
    try {
      return await underRoomLock(room, async () => {
        if (!(await adoptSharedRecord(room, bus))) {
          if (!force) return undefined
          throw new HTTPError({
            status: 409,
            message: "The document re-seeded on another instance. The room was re-seeded.",
            data: { code: realtimeSourceChangedCode },
          })
        }
        // Record the submitted state before saving. A later instance can distinguish a completed save from an
        // outside write if this process stops before recording the new digest. Later edits stay unsaved.
        return await saveRoomNow(room, reason, force,
          async (digest, state) => {
            const record = { epoch: room.epoch, digest, state }
            room.unwrittenRecord = record
            await writeSharedRecord(bus, room.key, record)
            room.unwrittenRecord = undefined
          },
          async (state) => {
            await writeSharedRecord(bus, room.key, { epoch: room.epoch, digest: room.digest, state, pending: true })
          })
      })
    }
    catch (error) {
      // Reads and recovery writes can fail before saveRoomNow installs its retry.
      if (room.dirty && room.resolved.persistence && !room.idleTimer) {
        room.retryDelay = Math.min(Math.max(room.resolved.persistence.debounce, room.retryDelay * 2), maxSaveRetryMs)
        scheduleSave(room, room.retryDelay)
      }
      throw error
    }
  }

  /** `onStored` gets the digest and the Yjs state of what the adapter stored, before later edits. */
  async function saveRoomNow(
    room: DocumentRoom,
    reason: RealtimeSaveOptions["reason"],
    force: boolean,
    onStored?: (digest: string | null, state: Uint8Array) => Promise<void>,
    onSubmitting?: (state: Uint8Array) => Promise<void>,
  ): Promise<RealtimeSaved | undefined> {
    const { adapter, persistence } = room.resolved
    const editor = room.editor
    if (room.guard.readOnly) {
      if (!force) return
      throw new HTTPError({ status: 409, message: readOnlyDocumentMessage, data: { code: realtimeReadOnlyCode } })
    }
    if (!room.dirty && !(force && room.digest === null)) {
      if (!force) return
      const status = readRealtimeStatus(room.document)
      return { ...status, document: await readRealtimeYDoc(editor, room.document) }
    }
    if (room.idleTimer) clearTimeout(room.idleTimer)
    room.idleTimer = undefined
    room.firstDirtyAt = undefined
    const revision = room.revision
    const editors = [...room.editors.values()]
    const user = editors.at(-1)
    const submitted = new Y.Doc()
    Y.applyUpdate(submitted, Y.encodeStateAsUpdate(room.document))
    const finishSave = () => {
      room.retryDelay = 0
      if (room.revision === revision) {
        room.dirty = false
        room.editors.clear()
      }
      else scheduleSave(room)
      persistRoom(room)
    }
    try {
      try {
        checkRealtimeBody(editor, submitted)
      }
      catch {
        // A codec reads such JSON as an empty or partial document. Writing it would lose content, so keep the room dirty.
        throw new HTTPError({ status: 422, message: invalidDocumentMessage, data: { code: realtimeInvalidDocumentCode } })
      }
      const written = await readRealtimeYDoc(editor, submitted)
      const document = { ...written, body: keepRealtimeFinalNewline(written.body, room.guard.finalNewline) }
      const { clean } = room.guard
      if (room.digest !== null && document.body === clean.body && realtimeJsonEqual(document.fields, clean.fields)) {
        // The edits cancel out, or only change the codec's own form of the stored document: write nothing.
        writeRealtimeStatus(submitted, { digest: room.digest, error: null }, serverOrigin)
        await onStored?.(room.digest, Y.encodeStateAsUpdate(submitted))
        Y.applyUpdate(room.document, Y.encodeStateAsUpdate(submitted), serverOrigin)
        finishSave()
        return { ...readRealtimeStatus(room.document), document }
      }
      const readsBack = await realtimeCodecReadsBack(editor, submitted, written.body)
      await onSubmitting?.(Y.encodeStateAsUpdate(submitted))
      let result
      try {
        result = await adapter.save(room.context, document, { editors, ifDigest: room.digest, reason, user })
      }
      catch (error) {
        if (!isRealtimeDocumentConflict(error) && !isWorkspaceConflict(error)) throw error
        // The stored document changed outside this room. It wins; clients reset and receive the
        // unsaved document as `previous` in their reset event.
        await reseedRoom(room, "source-changed")
        throw new HTTPError({
          status: 409,
          message: "The stored document changed outside this realtime room. The room was re-seeded.",
          data: { code: realtimeSourceChangedCode },
        })
      }
      room.digest = result.digest
      const storedBody = result.stored?.body ?? document.body
      room.guard = {
        clean: { body: storedBody, fields: result.stored?.fields ?? document.fields },
        finalNewline: storedBody.endsWith("\n"),
        issues: [],
        readOnly: false,
      }
      if (result.stored) {
        const update = await diffRealtimeYDoc(editor, submitted, result.stored)
        if (update.byteLength > 0) {
          Y.applyUpdate(room.document, update, serverOrigin)
          Y.applyUpdate(submitted, update, serverOrigin)
        }
      }
      const status = {
        digest: result.digest,
        error: null,
        issues: readsBack ? result.issues ?? [] : [...result.issues ?? [], codecReadBackIssue],
        savedAt: new Date().toISOString(),
        savedBy: user ?? null,
      }
      writeRealtimeStatus(submitted, status, serverOrigin)
      await onStored?.(result.digest, Y.encodeStateAsUpdate(submitted))
      Y.applyUpdate(room.document, Y.encodeStateAsUpdate(submitted), serverOrigin)
      finishSave()
      return { ...status, document: { ...document, ...result.stored, fields: result.stored?.fields ?? document.fields } }
    }
    catch (error) {
      if (room.destroyed || !room.dirty) throw error
      writeRealtimeStatus(room.document, { error: errorMessage(error) }, serverOrigin)
      if (persistence) {
        room.retryDelay = Math.min(Math.max(persistence.debounce, room.retryDelay * 2), maxSaveRetryMs)
        room.firstDirtyAt = undefined
        scheduleSave(room, room.retryDelay)
      }
      throw error
    }
    finally {
      submitted.destroy()
    }
  }

  /**
   * Shows a clean room's stored file with the fields that it loads now, when they differ from the room's: a schema can
   * read the same file differently. The new fields become the clean baseline. A state over the room quota changes nothing.
   */
  function refreshFields(room: DocumentRoom, fields: Record<string, RealtimeFieldValue>): void {
    const map = room.document.getMap(realtimeDocumentLayout.fields)
    if (holdsFields(map, fields)) return
    const candidate = new Y.Doc()
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.document))
      candidate.transact(() => writeRealtimeFields(candidate.getMap(realtimeDocumentLayout.fields), fields))
      assertRealtimeRoomStateQuota(candidate)
    }
    finally {
      candidate.destroy()
    }
    room.document.transact(() => writeRealtimeFields(map, fields), serverOrigin)
    room.guard = { ...room.guard, clean: { ...room.guard.clean, fields } }
    persistRoom(room)
  }

  /**
   * For a shared room, the whole refresh holds the room lock: a load from before another instance's reseed or save
   * would otherwise replace the newer record with stale state.
   */
  async function refreshRoom(room: DocumentRoom): Promise<{ digest: string | null, reseeded: boolean }> {
    return await underRoomLock(room, () => refreshRoomNow(room))
  }

  async function refreshRoomNow(room: DocumentRoom): Promise<{ digest: string | null, reseeded: boolean }> {
    // A save on another instance changed the stored digest inside the room.
    if (room.bus && !(await adoptSharedRecord(room, room.bus))) return { digest: room.digest, reseeded: true }
    const revision = room.revision
    const loaded = await room.resolved.adapter.load(room.context)
    // A client may edit while the adapter is loading. Preserve that live edit
    // and let the normal save path reconcile the external change.
    if (room.dirty || room.revision !== revision) return { digest: room.digest, reseeded: false }
    if (loaded.digest === room.digest) {
      refreshFields(room, loadedFields(loaded))
      return { digest: room.digest, reseeded: false }
    }
    const reseeded = await reseedRoom(room, "source-changed", loaded, true)
    return { digest: room.digest, reseeded }
  }

  /**
   * Refreshes an open room without unsaved edits. A dirty room finds the outside change at its next save. With a bus,
   * the rooms of the other instances refresh too, unless the call came from the bus.
   */
  async function refreshOpenRoom(definitionName: string, documentId: string, fanOut = true): Promise<boolean> {
    const key = realtimeRoomKey(definitionName, documentId)
    if (fanOut) {
      const bus = await sharedBus().catch(() => undefined)
      await bus?.publish({ type: "refresh", room: key, epoch: "", data: new Uint8Array() }).catch(() => {})
    }
    const pending = rooms.get(key)
    const room = pending ? await pending.catch(() => undefined) : undefined
    if (!room || room.kind !== "document" || room.destroyed) return false
    return await enqueue(room, async () => !room.dirty && (await refreshRoom(room)).reseeded)
  }
  localRefreshers().add(new WeakRef(refreshOpenRoom))

  /** Requests that wait for a browser's answer, by request id, with the id of the peer that must answer. */
  const pendingRequests = new Map<string, { peer: string, settle: (result: RealtimeRoomRequestResult) => void }>()

  /**
   * The browsers in a room. Inside a Durable Object they come from its sockets and their crossws attachment (`i` is the
   * peer id, `t` the subscribed channels), which outlive hibernation; elsewhere from the open room.
   */
  function requestTargets(key: string, durable: DurableSockets | undefined): Array<{ id: string, send: (frame: Uint8Array) => void }> {
    const channel = `vitehub:realtime:${key}`
    if (durable) {
      return durable.getWebSockets().flatMap((socket) => {
        const state = socket.deserializeAttachment()
        if (!state || typeof state !== "object" || !("i" in state) || typeof state.i !== "string" || !("t" in state)) return []
        const topics = state.t
        return topics instanceof Set && topics.has(channel) ? [{ id: state.i, send: (frame: Uint8Array) => socket.send(frame) }] : []
      })
    }
    const room = openRooms.get(key)
    return room ? [...room.peers].map(peer => ({ id: peer.id, send: (frame: Uint8Array) => peer.send(frame) })) : []
  }

  /** Asks the one browser in a room of this process or Durable Object. `requestRealtimeRoom()` calls it. */
  async function requestRoom(definitionName: string, documentId: string, body: unknown, ask: LocalRequestOptions, durable?: DurableSockets): Promise<RealtimeRoomRequestResult> {
    let definition: RealtimeDefinition
    try {
      definition = await getDefinition(definitionName)
    }
    catch {
      return roomRequestError("REALTIME_ROOM_REQUESTS_OFF", { definition: definitionName })
    }
    if (definition.document !== false || definition.requests !== true) return roomRequestError("REALTIME_ROOM_REQUESTS_OFF", { definition: definitionName })
    if (definition.scope === "user" && ask.user === undefined) {
      return roomRequestError("REALTIME_ROOM_REFUSED", { reason: `the Definition "${definitionName}" keeps a room per person, so the request must name one with { user }.` })
    }
    const key = realtimeRoomKey(definitionName, documentId, roomScope(definition, ask.user ?? null))
    const deadline = Date.now() + ask.wait
    let targets = requestTargets(key, durable)
    // A tab that reloads or reconnects leaves the room for a moment, and its old socket can close after the new one joins.
    while (targets.length !== 1 && Date.now() < deadline && !ask.signal?.aborted) {
      await new Promise(resolve => setTimeout(resolve, 50))
      targets = requestTargets(key, durable)
    }
    if (ask.signal?.aborted) return roomRequestError("REALTIME_ROOM_ABORTED")
    if (targets.length > 1) return roomRequestError("REALTIME_ROOM_CROWDED", { count: targets.length })
    const target = targets[0]
    if (!target) return roomRequestError(options.bus ? "REALTIME_ROOM_ELSEWHERE" : "REALTIME_ROOM_EMPTY")
    const id = crypto.randomUUID()
    return await new Promise<RealtimeRoomRequestResult>((resolve) => {
      const finish = (result: RealtimeRoomRequestResult) => {
        clearTimeout(timer)
        ask.signal?.removeEventListener("abort", abort)
        pendingRequests.delete(id)
        resolve(result)
      }
      const abort = () => finish(roomRequestError("REALTIME_ROOM_ABORTED"))
      const timer = setTimeout(() => finish(roomRequestError("REALTIME_ROOM_TIMEOUT", { timeout: ask.timeout })), ask.timeout)
      ask.signal?.addEventListener("abort", abort, { once: true })
      pendingRequests.set(id, { peer: target.id, settle: finish })
      try {
        target.send(encodeRealtimeRequestFrame({ kind: "request", id, body }))
      }
      catch {
        finish(roomRequestError("REALTIME_ROOM_EMPTY"))
      }
    })
  }
  // The handler below calls `requestRoom` for the Durable Object path, which keeps it alive as long as this handler.
  localRequesters().add(new WeakRef(requestRoom))

  /** Settles the request that a browser's answer frame names, when that browser is the one asked. */
  function settleRequest(peer: WebSocketPeer, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    let frame: RealtimeRequestFrame | undefined
    try {
      decoding.readVarUint(decoder)
      frame = decodeRealtimeRequestFramePayload(decoder)
    }
    catch {
      return
    }
    if (frame?.kind !== "answer") return
    const pending = pendingRequests.get(frame.id)
    if (!pending || pending.peer !== peer.id) return
    pending.settle(frame.ok ? [undefined, frame.body] : roomRequestError("REALTIME_ROOM_REFUSED", { reason: frame.why }))
  }

  const restoredPeerHandler = defineWebSocketHandler({
    message(peer, message: WebSocketMessage) {
      const data = message.uint8Array()
      if (data[0] === messageRealtimeRequest && data.byteLength <= maxMessageBytes) settleRequest(peer, data)
    },
  })

  /** The browser asked has left: its requests fail now instead of at their timeout. */
  function settleRequestsOf(peer: WebSocketPeer): void {
    for (const pending of pendingRequests.values()) {
      if (pending.peer === peer.id) pending.settle(roomRequestError("REALTIME_ROOM_EMPTY"))
    }
  }

  async function checkpointRoom(room: DocumentRoom, user: RealtimeUser | null): Promise<RealtimeCheckpoint> {
    const { adapter, definition } = room.resolved
    const configured = definition.history?.checkpoint
    const saved = (await saveRoom(room, "request", true))!
    if (!saved.digest) throw realtimeErrorDiagnostics.REALTIME_MISSING_DIGEST({ operation: "checkpoint" })
    let snapshot
    try {
      snapshot = await adapter.checkpoint!(room.context, {
        digest: saved.digest,
        message: configured === true ? undefined : configured?.message,
        user: user ?? saved.savedBy ?? undefined,
      })
    }
    catch (error) {
      if (!isRealtimeDocumentConflict(error) && !isWorkspaceConflict(error)) throw error
      await reseedRoom(room, "source-changed")
      throw new HTTPError({
        status: 409,
        message: "The stored document changed while checkpointing. The room was re-seeded.",
        data: { code: realtimeSourceChangedCode },
      })
    }
    return { ...saved, digest: saved.digest, snapshot }
  }

  async function requestContext(event: H3Event) {
    const { definitionName, documentId, searchParams, workspaceEvents } = parseRoomPath(event.req.url)
    const definition = await getDefinition(definitionName)
    const resolved = definition.document === false ? undefined : resolveRealtimeDefinition(definition)
    const user = await identify(event.req, event, definitionName, definition)
    const access = (mode: "read" | "write", id: string | null = workspaceEvents ? null : documentId) =>
      allows(definition, { definition: definitionName, documentId: id, event, mode, request: event.req, user })
    const scope = roomScope(definition, user?.id ?? null)
    return { access, definitionName, documentId, resolved, scope, searchParams, user, workspaceEvents }
  }

  const httpHandler = defineEventHandler(async (event) => {
    const url = new URL(event.req.url)
    const action = url.searchParams.get("history") === "checkpoint"
      ? "checkpoint"
      : url.searchParams.get("document")
    if (event.req.method !== "POST" || (action !== "checkpoint" && action !== "save" && action !== "refresh")) {
      throw new HTTPError({ status: 405 })
    }
    const request = await requestContext(event)
    if (request.workspaceEvents) throw new HTTPError({ status: 400, message: "Workspace events have no document to save." })
    const resolved = request.resolved
    if (!resolved) throw new HTTPError({ status: 404, message: "This Realtime Definition has no document." })
    // `resolveRealtimeDefinition()` rejects `history.checkpoint` on an adapter without `checkpoint()`.
    if (action === "checkpoint" && !resolved.definition.history?.checkpoint) {
      throw new HTTPError({ status: 404 })
    }
    if (!(await request.access("read")) || (action !== "refresh" && !(await request.access("write")))) {
      throw new HTTPError({ status: 403 })
    }
    const state = action === "refresh" ? undefined : await readRealtimeRequestState(event.req)
    if (state && !state.byteLength) throw new HTTPError({ status: 400, message: "Realtime document state is required." })
    const room = await getDocumentRoom(request.definitionName, request.documentId, resolved, resolveRealtimeRoomSql(event))
    if (action === "refresh") return await enqueue(room, async () => room.dirty ? { digest: room.digest, reseeded: false } : refreshRoom(room))
    return await enqueue(room, async () => {
      if (!containsRealtimeState(room.document, state!)) {
        throw new HTTPError({
          status: 409,
          message: "The realtime document is still syncing.",
          data: { code: realtimeSyncPendingCode },
        })
      }
      return action === "save"
        ? (await saveRoom(room, "request", true))!
        : await checkpointRoom(room, request.user)
    })
  })

  const websocketHandler = defineWebSocketHandler(async (event) => {
    const request = await requestContext(event)
    if (!(await request.access("read"))) throw new HTTPError({ status: 403 })
    const writable = !request.workspaceEvents && !!request.resolved && await request.access("write")
    const identity: RealtimeIdentity | undefined = request.user ? createRealtimeIdentity({ ...request.user }) : undefined
    const room: Room = request.workspaceEvents
      ? await getEventsRoom(JSON.stringify([request.definitionName, { workspaceEvents: true }]), true, undefined)
      : request.resolved
        ? await getDocumentRoom(request.definitionName, request.documentId, request.resolved, resolveRealtimeRoomSql(event))
        : await getEventsRoom(realtimeRoomKey(request.definitionName, request.documentId, request.scope), false, resolveRealtimeRoomSql(event))
    const clientEpoch = request.searchParams.get("epoch")
    // A browser on another editor version reads the room with another schema. TipTap deletes the nodes that schema does
    // not know from the shared document as soon as it renders, so the connection may read but never write.
    const otherEditor = room.kind === "document" && request.searchParams.get("editor") !== (room.editor.version ?? null)
    const clientId = request.searchParams.get("clientId")
    const awarenessClient = clientId !== null && /^\d+$/.test(clientId) && Number.isSafeInteger(Number(clientId)) ? Number(clientId) : undefined

    function leave(peer: WebSocketPeer) {
      settleRequestsOf(peer)
      if (terminalPeers.has(peer)) clearHeldUpdates(peer)
      else applyHeldUpdates(peer)
      if (!room.peers.delete(peer)) return
      const pendingAwareness = peerPendingAwareness.get(peer)
      if (pendingAwareness) clearTimeout(pendingAwareness.timer)
      peerPendingAwareness.delete(peer)
      const clients = room.awarenessOwners.release(peer)
      if (clients.length) {
        awarenessProtocol.removeAwarenessStates(room.awareness, clients, peer)
        // A client whose first update never applied has no clock, and nobody saw its state.
        const known = knownAwarenessClients(room.awareness, clients)
        if (known.length) {
          const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, known)
          peer.publish(room.channel, encodeAwareness(update))
          publish(room, "awareness", update)
        }
        room.awareness = compactRealtimeAwareness(room.awareness)
        watchAwareness(room)
      }
      peer.unsubscribe(room.channel)
      if (room.kind === "document" && room.writers.delete(peer) && room.held) {
        // The last writer leaving saves and releases; otherwise the hold names who is left.
        if (room.writers.size === 0) releaseHold(room)
        else holdRoom(room)
        return
      }
      if (room.kind === "document" && room.peers.size === 0 && room.dirty && room.resolved.persistence) {
        enqueue(room, () => saveRoom(room, "leave", false)).catch(() => {})
        return
      }
      releaseRoom(room)
    }

    function applyDocumentMessage(peer: WebSocketPeer, data: Uint8Array) {
      if (room.kind !== "document") return
      try {
        const readOnly = room.guard.readOnly ? readOnlyDocumentRejection : !writable || otherEditor
        const response = applyRealtimeSyncMessage(data, room.document, peer, { readOnly })
        if (response) peer.send(response)
      }
      catch (error) {
        // The deletes of another editor version arrive on their own when it renders. Closing would make the browser
        // reconnect and send them again, so drop them and keep the connection open for live updates.
        if (error instanceof RealtimeWriteRejected && otherEditor) return
        if (error instanceof RealtimeWriteRejected) peer.close(realtimeForbiddenWriteCloseCode, error.message)
        else peer.close(4400, "Realtime document exceeds its 8 MiB room quota.")
      }
    }

    function refillUpdates(peer: WebSocketPeer) {
      const now = Date.now()
      const bucket = peerSyncUpdates.get(peer) ?? { at: now, tokens: syncUpdateBurst }
      bucket.tokens = Math.min(syncUpdateBurst, bucket.tokens + (now - bucket.at) * syncUpdatesPerSecond / 1_000)
      bucket.at = now
      peerSyncUpdates.set(peer, bucket)
      return bucket
    }

    function holdUpdate(peer: WebSocketPeer, update: Uint8Array, bucket: { tokens: number }) {
      const held = peerHeldUpdates.get(peer)
      const bytes = (held?.bytes ?? 0) + update.byteLength
      if (bytes > maxMessageBytes) {
        terminalPeers.add(peer)
        clearHeldUpdates(peer)
        peer.close(1013, "Realtime updates are arriving too quickly.")
        return
      }
      if (held) {
        held.updates.push(update)
        held.bytes = bytes
        return
      }
      const wait = Math.ceil((1 - bucket.tokens) * 1_000 / syncUpdatesPerSecond)
      peerHeldUpdates.set(peer, { bytes, timer: setTimeout(() => applyHeldUpdates(peer), wait), updates: [update] })
    }

    /** Applies the updates a peer sent past its budget as one merged update, for one token. */
    function applyHeldUpdates(peer: WebSocketPeer) {
      if (terminalPeers.has(peer)) {
        clearHeldUpdates(peer)
        return
      }
      const held = peerHeldUpdates.get(peer)
      if (!held) return
      peerHeldUpdates.delete(peer)
      clearTimeout(held.timer)
      const bucket = refillUpdates(peer)
      bucket.tokens = Math.max(0, bucket.tokens - 1)
      applyDocumentMessage(peer, encodeSyncUpdate(held.updates.length === 1 ? held.updates[0]! : Y.mergeUpdates(held.updates)))
    }

    function applyAwareness(peer: WebSocketPeer, input: Uint8Array) {
      let clients: number[]
      try {
        clients = room.awarenessOwners.apply(room.awareness, peer, input, identity)
      }
      catch (error) {
        peer.close(error instanceof AwarenessOwnershipConflict ? 4500 : 4400, "Invalid awareness update.")
        return
      }
      // A client's first update has clock 0, which Yjs does not apply: there is nothing to relay for it yet.
      const known = knownAwarenessClients(room.awareness, clients)
      if (!known.length) return
      const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, known)
      peer.publish(room.channel, encodeAwareness(update))
      publish(room, "awareness", update)
    }

    return {
      open(peer) {
        if (room.kind === "document") {
          if (clientEpoch && clientEpoch !== room.epoch) {
            // The client holds Yjs state from an earlier seed. Merging it would duplicate content.
            peer.send(encodeRealtimeControl({ type: "reset", epoch: room.epoch, reason: "stale" }))
            peer.close(realtimeResetCloseCode, "The realtime document was re-seeded.")
            releaseRoom(room)
            return
          }
          if (request.user) room.peerUsers.set(peer, request.user)
        }
        room.peers.add(peer)
        peer.subscribe(room.channel)
        if (awarenessClient !== undefined && room.awarenessOwners.claim(room.awareness, peer, awarenessClient, identity)) {
          const claim = encoding.createEncoder()
          encoding.writeVarUint(claim, awarenessClient)
          publish(room, "claim", encoding.toUint8Array(claim))
        }
        if (room.kind === "document") {
          const reason: RealtimeReadOnlyReason | undefined = room.guard.readOnly ? "document" : !writable ? "access" : otherEditor ? "version" : undefined
          peer.send(encodeRealtimeControl(reason
            ? { type: "session", access: "read", epoch: room.epoch, reason }
            : { type: "session", access: "write", epoch: room.epoch }))
          if (!reason) {
            room.writers.add(peer)
            holdRoom(room)
          }
        }
        peer.send(encodeSyncStep1(room.document))
        const clients = [...room.awareness.getStates().keys()]
        if (clients.length) peer.send(encodeAwarenessState(room.awareness, clients))
      },
      message(peer, message: WebSocketMessage) {
        const data = message.uint8Array()
        // An answer to `requestRealtimeRoom()`. It is matched by the peer id, so it still settles after a Durable Object
        // woke from hibernation and its rooms in memory are new.
        if (data[0] === messageRealtimeRequest) {
          if (data.byteLength <= maxMessageBytes) settleRequest(peer, data)
          return
        }
        if (!room.peers.has(peer)) return
        // On Cloudflare the Durable Object answers the keepalive itself, so it reaches this hook only on other hosts.
        if (data.byteLength === keepalivePing.byteLength && data.every((byte, index) => byte === keepalivePing[index])) {
          peer.send(realtimeKeepalivePong)
          return
        }
        if (data.byteLength > maxMessageBytes) {
          peer.close(4400, "Realtime message exceeds 1 MiB.")
          return
        }
        const decoder = decoding.createDecoder(data)
        let messageType: number
        try {
          messageType = decoding.readVarUint(decoder)
        }
        catch {
          peer.close(4400, "Invalid realtime message.")
          return
        }
        if (messageType === messageWorkspaceChange) {
          if (room.kind !== "events" || !room.workspace) {
            peer.close(4400, "Workspace changes require the workspace room.")
            return
          }
          let change
          try {
            change = decodeWorkspaceChangePayload(decoder)
          }
          catch {
            peer.close(4400, "Invalid workspace change.")
            return
          }
          if (!change) {
            peer.close(4400, "Invalid workspace change.")
            return
          }
          const now = Date.now()
          let quota = peerWorkspaceChanges.get(peer)
          if (!quota || now - quota.startedAt >= workspaceChangeWindowMs) {
            quota = { count: 0, startedAt: now }
            peerWorkspaceChanges.set(peer, quota)
          }
          quota.count++
          if (quota.count > workspaceChangeLimit) {
            peer.close(4429, "Workspace change rate limit exceeded.")
            return
          }
          const frame = encodeWorkspaceChange(change)
          peer.publish(room.channel, frame)
          publish(room, "frame", frame)
          return
        }
        if (messageType === messageQueryAwareness) {
          const now = Date.now()
          const previous = peerAwarenessQueryAt.get(peer)
          if (previous !== undefined && now - previous < awarenessQueryIntervalMs) return
          peerAwarenessQueryAt.set(peer, now)
          const clients = [...room.awareness.getStates().keys()]
          if (clients.length) peer.send(encodeAwarenessState(room.awareness, clients))
          return
        }
        if (messageType === messageAwareness) {
          let update: Uint8Array
          try {
            update = decoding.readVarUint8Array(decoder)
          }
          catch {
            peer.close(4400, "Invalid awareness update.")
            return
          }
          const now = Date.now()
          const previous = peerAwarenessUpdateAt.get(peer)
          if (previous !== undefined && now - previous < awarenessUpdateIntervalMs) {
            const pending = peerPendingAwareness.get(peer)
            if (pending) pending.update = update
            else {
              const next = {
                timer: setTimeout(() => {
                  peerPendingAwareness.delete(peer)
                  peerAwarenessUpdateAt.set(peer, Date.now())
                  if (room.peers.has(peer)) applyAwareness(peer, next.update)
                }, awarenessUpdateIntervalMs - (now - previous)),
                update,
              }
              peerPendingAwareness.set(peer, next)
            }
            return
          }
          peerAwarenessUpdateAt.set(peer, now)
          applyAwareness(peer, update)
          return
        }
        if (messageType !== messageSync) return
        try {
          const syncType = decoding.readVarUint(decoder)
          if (room.kind === "events") {
            if (syncType === syncProtocol.messageYjsSyncStep1) {
              const response = applyRealtimeSyncMessage(data, room.document, peer)
              if (response) peer.send(response)
            }
            else if (syncType !== syncProtocol.messageYjsSyncStep2) {
              peer.close(4400, room.workspace ? "Document updates cannot use the workspace room." : "This Realtime Definition has no document.")
            }
            return
          }
          const initialSyncStep2 = syncType === syncProtocol.messageYjsSyncStep2 && !peerInitialSyncStep2.has(peer)
          if (initialSyncStep2) peerInitialSyncStep2.add(peer)
          else if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
            const bucket = refillUpdates(peer)
            // Keep the order: once one update waits, the ones after it wait too.
            if (peerHeldUpdates.has(peer) || bucket.tokens < 1) {
              holdUpdate(peer, decoding.readVarUint8Array(decoder), bucket)
              return
            }
            bucket.tokens--
          }
          applyDocumentMessage(peer, data)
        }
        catch {
          peer.close(4400, "Invalid realtime message.")
        }
      },
      close(peer) {
        leave(peer)
      },
      error(peer) {
        leave(peer)
      },
    }
  })

  const handler = defineEventHandler(async (event) => {
    const forwarded = await forwardToCloudflareDurableObject(event)
    if (forwarded) return forwarded
    // Inside the Durable Object, a refresh from refreshRealtimeDocument(). The Worker strips the header from client requests.
    if (event.req.headers.has(internalRefreshHeader) && resolveRealtimeRoomSql(event)) {
      const { definitionName, documentId } = parseRoomPath(event.req.url)
      return { reseeded: await refreshOpenRoom(definitionName, documentId) }
    }
    // Inside the Durable Object, a request from requestRealtimeRoom(). The Worker strips the header from client requests.
    if (event.req.headers.has(internalRequestHeader) && resolveRealtimeRoomSql(event)) {
      const { definitionName, documentId } = parseRoomPath(event.req.url)
      const input: unknown = await event.req.json().catch(() => undefined)
      const field = (name: string) => input && typeof input === "object" && name in input ? (input as Record<string, unknown>)[name] : undefined
      const timeout = field("timeout")
      const wait = field("wait")
      const user = field("user")
      const context = resolveCloudflare(event)?.context
      return toDurableRequestReply(await requestRoom(definitionName, documentId, field("body"), {
        timeout: typeof timeout === "number" && timeout > 0 ? timeout : defaultRequestTimeout,
        wait: typeof wait === "number" && wait >= 0 ? wait : defaultRequestWait,
        ...(typeof user === "string" || user === null ? { user } : {}),
      }, isDurableSockets(context) ? context : undefined))
    }
    // After a Durable Object hibernates, crossws restores each socket's peer with a bare GET of its first URL, with no
    // headers, and resolves its hooks again. Those hooks take the answers to `requestRealtimeRoom()`, which match by
    // peer id. The rest of the room protocol still needs the original upgrade.
    if (event.req.method === "GET" && isBareRequest(event.req)) return restoredPeerHandler(event)
    if (event.req.headers.get("upgrade")?.toLowerCase() !== "websocket") return httpHandler(event)
    try {
      return await websocketHandler(event)
    }
    catch (error) {
      return refuseUpgrade(event.req, error instanceof HTTPError ? error.status : 500)
    }
  })
  // SAFETY: H3 attaches a Fetch-compatible method to every defined event handler.
  return handler as RealtimeHandler
}
