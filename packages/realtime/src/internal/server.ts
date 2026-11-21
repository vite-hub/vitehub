import { assertAuthOrigin } from "@vite-hub/auth/internal/server"
import { isWorkspaceConflict, normalizeSafeWorkspacePath } from "@vite-hub/workspace/files"
import { HTTPError, defineEventHandler, defineWebSocketHandler } from "nitro/h3"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { H3Event, WebSocketHooks, WebSocketMessage, WebSocketPeer } from "h3"
import type { RealtimeRequestFrame } from "../protocol.ts"
import type { RealtimeBus, RealtimeBusMessage, RealtimeBusMessageType, RealtimeRoomRecord } from "../bus-protocol.ts"
import type {} from "@vite-hub/runtime/internal/h3"
import type { RealtimeRoomSql } from "../cloudflare-sql.ts"
import type { RealtimeIdentity } from "../presence.ts"
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
} from "../types.ts"
import { createRealtimeIdentity } from "../presence.ts"
import { AwarenessOwnershipConflict, compactRealtimeAwareness, createRealtimeAwarenessOwners } from "../awareness.ts"
import { isRealtimeDocumentConflict } from "../conflict.ts"
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
} from "../document.ts"
import { assertRealtimeAccess, assertRealtimeCheckpoint } from "../definition.ts"
import { realtimeMarkdownEditor } from "../editor.ts"
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
} from "../protocol.ts"
import { readRealtimeRequestState } from "../transport.ts"
import { workspaceDocument } from "../workspace-document.ts"
import { realtimeErrorDiagnostics } from "../error-diagnostics.ts"
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
} from "../request.ts"
import type { DurableSockets, LocalRequestOptions, RealtimeDurableObjectNamespace, RealtimeRoomRequestResult } from "../request.ts"
import { hasNativeCloudflareSql } from "../cloudflare-sql.ts"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

export { isRealtimeAvailable } from "../availability.ts"
export { blobDocument } from "../blob-document.ts"
export type { RealtimeBlobDocumentOptions, RealtimeBlobStore } from "../blob-document.ts"
export { applyRealtimeAwarenessUpdate, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness } from "../awareness.ts"
export { RealtimeDocumentConflict, isRealtimeDocumentConflict } from "../conflict.ts"
export { containsRealtimeState, createRealtimeYDoc, diffRealtimeYDoc, readRealtimeStatus, readRealtimeYDoc, realtimeDocumentLayout } from "../document.ts"
export { readRealtimeRequestState } from "../transport.ts"
export { isRealtimeWorkspaceDocument, readRealtimeWorkspaceDocument, workspaceDocument } from "../workspace-document.ts"
export type { RealtimeWorkspaceDocumentAdapter } from "../workspace-document.ts"

export type { RealtimeBus, RealtimeBusMessage, RealtimeRoomRecord } from "../bus-protocol.ts"
export { requestRealtimeRoom } from "../request.ts"
export type { RealtimeDurableObjectNamespace, RealtimeRoomRequestOptions, RealtimeRoomRequestResult } from "../request.ts"

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
const syncUpdateBurst = 40
const syncUpdatesPerSecond = 20
const durableUpdateCompactionInterval = 128
const maxSaveRetryMs = 60_000
const holdIntervalMs = 60_000
const messageSync = 0
const keepalivePing = new TextEncoder().encode(realtimeKeepalivePing)
const internalRefreshHeader = "x-vitehub-realtime-refresh"

export const realtimePersistenceDefaults = Object.freeze({ debounce: 2_000, maxWait: 10_000 })

const serverOrigin = Symbol("vitehub.realtime.server")
const busOrigin = Symbol("vitehub.realtime.bus")
const emptyUpdateBytes = 2
const eventsEpoch = "events"

function loadedFields(loaded: RealtimeLoadedDocument): Record<string, RealtimeFieldValue> {
  return Object.fromEntries(Object.entries(loaded.fields ?? {}).filter(([, value]) => value !== undefined))
}

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

function knownAwarenessClients(awareness: awarenessProtocol.Awareness, clients: readonly number[]): number[] {
  return clients.filter(client => awareness.meta.has(client))
}

function changesOnlyStatus(document: Y.Doc, transaction: Y.Transaction): boolean {
  const status: object = document.getMap(realtimeDocumentLayout.status)
  for (const type of transaction.changed.keys()) {
    if (type !== status) return false
  }
  return true
}

function isWriteRejected(error: unknown): error is Error {
  return error instanceof Error && Reflect.get(error, "code") === "REALTIME_WRITE_REJECTED"
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
  if (syncType === 0) return apply(document)
  const candidate = new Y.Doc()
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document))
    const before = Y.snapshot(candidate)
    apply(candidate)
    if (candidate.store.pendingStructs || candidate.store.pendingDs) {
      throw realtimeErrorDiagnostics.REALTIME_WRITE_REJECTED({ problem: "missing-state" })
    }
    if (options.readOnly && !Y.equalSnapshots(before, Y.snapshot(candidate))) {
      throw realtimeErrorDiagnostics.REALTIME_WRITE_REJECTED({ problem: "read-only", ...(typeof options.readOnly === "string" ? { readOnly: options.readOnly } : {}) })
    }
    if (options.protectStatus !== false && realtimeStatusFingerprint(candidate) !== realtimeStatusFingerprint(document)) {
      throw realtimeErrorDiagnostics.REALTIME_WRITE_REJECTED({ problem: "status" })
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
  return JSON.stringify(scope === undefined ? [definitionName, documentId] : [definitionName, documentId, scope])
}

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
  const adapter = isDocumentAdapter(document) ? document : workspaceDocument(document.workspace, document.checkpointAuthor)
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
  bus?: RealtimeBus
  channel: string
  document: Y.Doc
  key: string
  peers: Set<WebSocketPeer>
}

interface EventsRoom extends RoomBase {
  kind: "events"
  workspace: boolean
}

interface DocumentRoom extends RoomBase {
  context: RealtimeDocumentContext
  destroyed: boolean
  digest: string | null
  dirty: boolean
  editor: RealtimeEditor
  editors: Map<string, RealtimeUser>
  held: boolean
  holdError?: string
  holdTimer?: ReturnType<typeof setInterval>
  writers: Set<WebSocketPeer>
  locked?: boolean
  epoch: string
  firstDirtyAt?: number
  guard: DocumentGuard
  idleTimer?: ReturnType<typeof setTimeout>
  kind: "document"
  operations: number
  peerUsers: WeakMap<WebSocketPeer, RealtimeUser>
  persistedUpdates: number
  pendingRecovery?: { digest: string | null, since: number }
  queue: Promise<void>
  resolved: ResolvedRealtimeDefinition
  retryDelay: number
  revision: number
  unwrittenRecord?: RealtimeRoomRecord
  sql?: RealtimeRoomSql
}

type Room = DocumentRoom | EventsRoom

interface DocumentGuard {
  clean: { body: string, fields: Record<string, RealtimeFieldValue> }
  finalNewline: boolean
  issues: RealtimeIssue[]
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
  catch {}
  sql.exec("CREATE TABLE IF NOT EXISTS vitehub_realtime_document_updates (sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_key TEXT NOT NULL, update_blob BLOB NOT NULL, client_update INTEGER NOT NULL DEFAULT 1)")
  try {
    sql.exec("ALTER TABLE vitehub_realtime_document_updates ADD COLUMN client_update INTEGER NOT NULL DEFAULT 1")
    return true
  }
  catch {
    try {
      sql.exec("SELECT client_update FROM vitehub_realtime_document_updates LIMIT 0").toArray()
      return true
    }
    catch {
      return false
    }
  }
}

function migrateLegacyDocument(sql: RealtimeRoomSql, key: string, clientUpdateColumn: boolean): void {
  if (sql.exec("SELECT room_key FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray().length) return
  let legacy: Record<string, unknown> | undefined
  try {
    legacy = sql.exec("SELECT baseline_digest, update_blob FROM vitehub_realtime_rooms WHERE room_key = ?", key).toArray()[0]
  }
  catch {}
  if (!legacy) return
  let updates: Array<Record<string, unknown>> = []
  try {
    updates = sql.exec("SELECT update_blob FROM vitehub_realtime_updates WHERE room_key = ? ORDER BY sequence", key).toArray()
  }
  catch {}
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
    if (clientUpdateColumn) {
      try {
        sql.exec(
          "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob, client_update) VALUES (?, ?, 1)",
          key,
          blob,
        )
        continue
      }
      catch {}
    }
    sql.exec(
      "INSERT INTO vitehub_realtime_document_updates (room_key, update_blob) VALUES (?, ?)",
      key,
      blob,
    )
  }
}

function readStoredRoom(sql: RealtimeRoomSql, key: string): Record<string, unknown> | undefined {
  try {
    return sql.exec("SELECT epoch, digest, dirty, update_blob, editor_version FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray()[0]
  }
  catch {
    return sql.exec("SELECT epoch, digest, dirty, update_blob FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray()[0]
  }
}

function parseRoomPath(url: string): { definitionName: string, documentId: string, searchParams: URLSearchParams, workspaceEvents: boolean } {
  const parsed = new URL(url)
  const path = parsed.pathname
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
  if (definition.authorize === true && !definition.identify) {
    let auth
    try {
      auth = await assertAuthOrigin(request, event)
    }
    catch {
      throw new HTTPError({ status: 403 })
    }
    const session = await auth.api.getSession({ headers: request.headers })
    const user = toRealtimeUser(session?.user)
    if (!user) throw new HTTPError({ status: 401 })
    return user
  }
  const origin = request.headers.get("origin")
  const foreign = !!origin && origin !== forwardedRequestOrigin(request)
  const readsCallbackSession = typeof definition.authorize === "function" && !definition.identify && !!origin && (!foreign || !definition.origins)
  if (foreign && !readsCallbackSession && !(await definition.origins?.({ definition: definitionName, event, origin, request }))) {
    throw new HTTPError({ status: 403, message: "Realtime requests must come from the application origin." })
  }
  if (definition.identify) {
    const user = toRealtimeUser(await definition.identify({ definition: definitionName, event, request }))
    if (definition.authorize === true && !user) throw new HTTPError({ status: 401 })
    return user
  }
  const readsSession = typeof definition.authorize === "function"
    ? readsCallbackSession
    : definition.document === false && definition.scope === "user"
  if (!readsSession) return null
  let auth
  try {
    auth = await assertAuthOrigin(request, event)
  }
  catch (error) {
    if (!foreign && isMissingAuth(error)) return null
    throw new HTTPError({ status: 403 })
  }
  const session = await auth.api.getSession({ headers: request.headers })
  return toRealtimeUser(session?.user)
}

function isMissingAuth(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "AUTH_R0005"
}

async function allows(
  definition: RealtimeDefinition,
  context: RealtimeAuthorizeContext,
): Promise<boolean> {
  if (definition.authorize === true) return true
  if (definition.authorize) return (await definition.authorize(context)) === true
  return definition.access === "public"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return "The realtime document could not be saved."
}

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
    catch {}
  }
  return reseeded
}

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

function refuseUpgrade(request: Request, status: number): Response {
  const hooks: Partial<WebSocketHooks> = { upgrade: () => new Response(null, { status }) }
  const target = request as Request & { context?: Record<symbol, unknown>, [webSocketHooksKey]?: Partial<WebSocketHooks> }
  target[webSocketHooksKey] = hooks
  if (target.context) target.context[webSocketHooksKey] = hooks
  return Object.assign(new Response(null, { status }), { crossws: hooks })
}

const webSocketHooksKey = Symbol.for("crossws.hooks")

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
  const openRooms = new Map<string, Room>()
  const remoteOwners = new Map<string, object>()
  const repairRequestedAt = new WeakMap<Room, number>()
  const syncing = new WeakSet<Room>()

  function sharedBus(): Promise<RealtimeBus | undefined> {
    if (!options.bus) return Promise.resolve(undefined)
    if (pendingBus) return pendingBus
    const connect = options.bus
    const pending = (async () => {
      const bus = await connect()
      if (!bus) return undefined
      await bus.subscribe(receive, () => {
        for (const room of rooms.values()) room.then(requestSync, () => {})
      })
      bus.onClose(announceDeparture)
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

  function requestSync(room: Room): void {
    if (!room.bus) return
    if (room.kind !== "document") {
      publish(room, "sync", new Uint8Array())
      return
    }
    if (room.destroyed || syncing.has(room)) return
    if (!room.peers.size && !room.dirty) {
      publish(room, "sync", Y.encodeStateVector(room.document))
      return
    }
    syncing.add(room)
    enqueue(room, async () => {
      const record = await room.bus?.readRoom(room.key)
      if (room.destroyed) return
      if (record && record.epoch !== room.epoch) await reseedRoom(room, "source-changed", undefined, false, true)
      if (!room.destroyed) publish(room, "sync", Y.encodeStateVector(room.document))
    }).catch((error: unknown) => {
      console.error("[vitehub] Realtime could not repair a shared room.", error)
    }).finally(() => syncing.delete(room))
  }

  function localAwarenessClients(room: RoomBase): number[] {
    return knownAwarenessClients(room.awareness, [...room.awareness.getStates().keys()].filter(client => room.awarenessOwners.ownsLocally(client)))
  }

  async function announceDeparture(): Promise<void> {
    const sent: Array<Promise<void>> = []
    for (const pending of rooms.values()) {
      const room = await pending.catch(() => undefined)
      if (!room?.bus) continue
      const clients = localAwarenessClients(room)
      if (!clients.length) continue
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

  function receive(message: RealtimeBusMessage): void {
    if (message.type === "refresh") {
      const key: unknown = JSON.parse(message.room)
      const [definitionName, documentId]: unknown[] = Array.isArray(key) ? key : []
      if (typeof definitionName === "string" && typeof documentId === "string") refreshOpenRoom(definitionName, documentId, false).catch(() => {})
      return
    }
    if (message.type === "reset") {
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
        catch { }
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
    assertRealtimeAccess(module.default)
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
      document.destroy()
    }
    throw new HTTPError({ status: 503, message: "Realtime instances changed this room at the same time. Connect again." })
  }

  async function writeSharedRecord(bus: RealtimeBus, key: string, record: RealtimeRoomRecord): Promise<void> {
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (await bus.writeRoom(key, record, record.epoch)) return
        console.error("[vitehub] Realtime room record compare-and-set failed.", key)
        throw realtimeErrorDiagnostics.REALTIME_ROOM_WRITE_CONFLICT()
      }
      catch (error) { failure = error }
    }
    console.error("[vitehub] Realtime could not write the shared room record.", failure)
    throw failure
  }

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
          const fields = document.getMap(realtimeDocumentLayout.fields)
          if (!dirty && !holdsFields(fields, guard.clean.fields)) {
            document.transact(() => writeRealtimeFields(fields, guard.clean.fields), serverOrigin)
            refreshedFields = true
          }
          assertRealtimeRoomStateQuota(document)
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
      if (replacedEpoch) publish(room, "reset", new Uint8Array())
      requestSync(room)
      return room
    })
  }

  function persistRoom(room: DocumentRoom): void {
    if (!room.sql) return
    const row = [room.key, room.epoch, room.digest, room.dirty ? 1 : 0, Uint8Array.from(Y.encodeStateAsUpdate(room.document)).buffer]
    try {
      room.sql.exec(
        "INSERT OR REPLACE INTO vitehub_realtime_documents (room_key, epoch, digest, dirty, update_blob, editor_version) VALUES (?, ?, ?, ?, ?, ?)",
        ...row,
        room.editor.version ?? null,
      )
    }
    catch {
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

  function releaseRoom(room: Room): void {
    if (room.peers.size > 0) return
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
    if (room.bus && !room.dirty) {
      destroyRoom(room)
      return
    }
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

  function holdUsers(room: DocumentRoom): RealtimeUser[] {
    const users = new Map<string, RealtimeUser>()
    for (const peer of room.writers) {
      const user = room.peerUsers.get(peer)
      if (user && !users.has(user.id)) users.set(user.id, user)
    }
    return [...users.values()]
  }

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
    if (!room.bus && stale()) {
      next.destroy()
      return false
    }
    const previous = { awareness: room.awareness, document: room.document }
    const peers = [...room.peers]
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
      if (room.dirty && room.resolved.persistence && !room.idleTimer) {
        room.retryDelay = Math.min(Math.max(room.resolved.persistence.debounce, room.retryDelay * 2), maxSaveRetryMs)
        scheduleSave(room, room.retryDelay)
      }
      throw error
    }
  }

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
        throw new HTTPError({ status: 422, message: invalidDocumentMessage, data: { code: realtimeInvalidDocumentCode } })
      }
      const written = await readRealtimeYDoc(editor, submitted)
      const document = { ...written, body: keepRealtimeFinalNewline(written.body, room.guard.finalNewline) }
      const { clean } = room.guard
      if (room.digest !== null && document.body === clean.body && realtimeJsonEqual(document.fields, clean.fields)) {
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

  async function refreshRoom(room: DocumentRoom): Promise<{ digest: string | null, reseeded: boolean }> {
    return await underRoomLock(room, () => refreshRoomNow(room))
  }

  async function refreshRoomNow(room: DocumentRoom): Promise<{ digest: string | null, reseeded: boolean }> {
    if (room.bus && !(await adoptSharedRecord(room, room.bus))) return { digest: room.digest, reseeded: true }
    const revision = room.revision
    const loaded = await room.resolved.adapter.load(room.context)
    if (room.dirty || room.revision !== revision) return { digest: room.digest, reseeded: false }
    if (loaded.digest === room.digest) {
      refreshFields(room, loadedFields(loaded))
      return { digest: room.digest, reseeded: false }
    }
    const reseeded = await reseedRoom(room, "source-changed", loaded, true)
    return { digest: room.digest, reseeded }
  }

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

  const pendingRequests = new Map<string, { peer: string, settle: (result: RealtimeRoomRequestResult) => void }>()

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
  localRequesters().add(new WeakRef(requestRoom))

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
        user: user ?? undefined,
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
    if (action === "checkpoint" && !resolved.definition.history?.checkpoint) {
      throw new HTTPError({ status: 404 })
    }
    if (!(await request.access("read")) || (action !== "refresh" && !(await request.access("write")))) {
      throw new HTTPError({ status: request.user ? 403 : 401 })
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
    if (!(await request.access("read"))) throw new HTTPError({ status: request.user ? 403 : 401 })
    const writable = !request.workspaceEvents && !!request.resolved && await request.access("write")
    const identity: RealtimeIdentity | undefined = request.user ? createRealtimeIdentity({ ...request.user }) : undefined
    const room: Room = request.workspaceEvents
      ? await getEventsRoom(JSON.stringify([request.definitionName, { workspaceEvents: true }]), true, undefined)
      : request.resolved
        ? await getDocumentRoom(request.definitionName, request.documentId, request.resolved, resolveRealtimeRoomSql(event))
        : await getEventsRoom(realtimeRoomKey(request.definitionName, request.documentId, request.scope), false, resolveRealtimeRoomSql(event))
    const clientEpoch = request.searchParams.get("epoch")
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
        if (isWriteRejected(error) && otherEditor) return
        if (isWriteRejected(error)) peer.close(realtimeForbiddenWriteCloseCode, error.message)
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
        if (data[0] === messageRealtimeRequest) {
          if (data.byteLength <= maxMessageBytes) settleRequest(peer, data)
          return
        }
        if (!room.peers.has(peer)) return
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
    if (event.req.headers.has(internalRefreshHeader) && resolveRealtimeRoomSql(event)) {
      const { definitionName, documentId } = parseRoomPath(event.req.url)
      return { reseeded: await refreshOpenRoom(definitionName, documentId) }
    }
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
