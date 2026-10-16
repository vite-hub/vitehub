import { assertAuthOrigin } from "@vite-hub/auth/server"
import { isWorkspaceConflict, normalizeSafeWorkspacePath } from "@vite-hub/workspace"
import { HTTPError, defineEventHandler, defineWebSocketHandler } from "h3"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { WebSocketHooks, WebSocketMessage, WebSocketPeer } from "h3"
import type { RealtimeIdentity } from "./presence.ts"
import type {
  RealtimeCheckpoint,
  RealtimeDefinition,
  RealtimeDocumentAdapter,
  RealtimeDocumentContext,
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
  containsRealtimeState,
  createRealtimeYDoc,
  diffRealtimeYDoc,
  keepRealtimeFinalNewline,
  readRealtimeStatus,
  readRealtimeYDoc,
  realtimeCodecReadsBack,
  realtimeJsonEqual,
  realtimeStatusFingerprint,
  writeRealtimeStatus,
} from "./document.ts"
import { realtimeMarkdownEditor } from "./editor.ts"
import {
  decodeWorkspaceChangePayload,
  encodeRealtimeControl,
  encodeWorkspaceChange,
  messageAwareness,
  messageQueryAwareness,
  messageWorkspaceChange,
  realtimeForbiddenWriteCloseCode,
  realtimeReadOnlyCode,
  realtimeResetCloseCode,
  realtimeSourceChangedCode,
  realtimeSyncPendingCode,
} from "./protocol.ts"
import { readRealtimeRequestState } from "./transport.ts"
import { workspaceDocument } from "./workspace-document.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

export { applyRealtimeAwarenessUpdate, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness } from "./awareness.ts"
export { RealtimeDocumentConflict, isRealtimeDocumentConflict } from "./conflict.ts"
export { containsRealtimeState, createRealtimeYDoc, diffRealtimeYDoc, readRealtimeStatus, readRealtimeYDoc, realtimeDocumentLayout } from "./document.ts"
export { readRealtimeRequestState } from "./transport.ts"
export { isRealtimeWorkspaceDocument, readRealtimeWorkspaceDocument, workspaceDocument } from "./workspace-document.ts"
export type { RealtimeWorkspaceDocumentAdapter } from "./workspace-document.ts"

export interface RealtimeHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

const routePrefix = "/api/_vitehub/realtime/"
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
/** Marks the request that `refreshRealtimeDocument()` sends to a Durable Object. The Worker strips it from client requests. */
const internalRefreshHeader = "x-vitehub-realtime-refresh"
/**
 * The one Durable Object instance that holds every room. Nitro's `cloudflare-durable` entry hands each WebSocket upgrade
 * to this instance before the application runs, so saves, checkpoints, and refreshes must reach it too: a Durable
 * Object per room would have no peers and never match a room's state.
 */
const durableRoomsInstance = "server"

export const realtimePersistenceDefaults = Object.freeze({ debounce: 2_000, maxWait: 10_000 })

/** Origin of updates that the server writes itself: seeds, stored-form merges, and status. */
const serverOrigin = Symbol("vitehub.realtime.server")

const readOnlyDocumentMessage = "The editor cannot save this document without loss. The room is read-only."
const readOnlyDocumentRejection = "This realtime document is read-only: the editor cannot save it without loss."
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
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(encoder)
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- `readOnly` is a flag or a rejection message.
      throw new RealtimeWriteRejected(typeof options.readOnly === "string" ? options.readOnly : "This realtime connection is read-only.")
    }
    if (options.protectStatus !== false && realtimeStatusFingerprint(candidate) !== realtimeStatusFingerprint(document)) {
      throw new RealtimeWriteRejected("Realtime document status is written by the server.")
    }
    if (Y.encodeStateAsUpdate(candidate).byteLength > (options.maxStateBytes ?? maxRoomStateBytes)) {
      throw realtimeErrorDiagnostics.REALTIME_R0005({ message: "Realtime document exceeds its 8 MiB room quota." })
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

export function realtimeRoomKey(definitionName: string, documentId: string): string {
  return JSON.stringify([definitionName, documentId])
}

function storedUpdate(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

interface ResolvedRealtimeDefinition {
  adapter: RealtimeDocumentAdapter
  definition: RealtimeDefinition
  /** The codec of one document: the definition's editor, or the one its editor function picks. */
  editor: (context: RealtimeDocumentContext) => RealtimeEditor
  persistence: { debounce: number, maxWait: number } | false
}

const resolvedDefinitions = new WeakMap<RealtimeDefinition, ResolvedRealtimeDefinition>()

function isDocumentAdapter(document: RealtimeDefinition["document"]): document is RealtimeDocumentAdapter {
  return "load" in document && "save" in document
}

function duration(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Persistence timing comes from an untyped definition module.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw realtimeErrorDiagnostics.REALTIME_R0015({ message: `Realtime persistence.${name} must be a non-negative number of milliseconds.` })
  }
  return value
}

/** Resolves the document adapter, editor codec, and persistence timing of a definition. */
export function resolveRealtimeDefinition(definition: RealtimeDefinition): ResolvedRealtimeDefinition {
  const cached = resolvedDefinitions.get(definition)
  if (cached) return cached
  const document = definition.document
  const adapter = isDocumentAdapter(document) ? document : workspaceDocument(document.workspace)
  const persistence = definition.persistence === false
    ? false as const
    : {
        debounce: duration(definition.persistence?.debounce, realtimePersistenceDefaults.debounce, "debounce"),
        maxWait: duration(definition.persistence?.maxWait, realtimePersistenceDefaults.maxWait, "maxWait"),
      }
  if (persistence && persistence.maxWait < persistence.debounce) {
    throw realtimeErrorDiagnostics.REALTIME_R0015({ message: "Realtime persistence.maxWait must be at least persistence.debounce." })
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
  channel: string
  document: Y.Doc
  key: string
  peers: Set<WebSocketPeer>
}

interface EventsRoom extends RoomBase {
  kind: "events"
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
  epoch: string
  firstDirtyAt?: number
  guard: DocumentGuard
  idleTimer?: ReturnType<typeof setTimeout>
  kind: "document"
  operations: number
  peerUsers: WeakMap<WebSocketPeer, RealtimeUser>
  persistedUpdates: number
  queue: Promise<void>
  resolved: ResolvedRealtimeDefinition
  retryDelay: number
  revision: number
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
  const fields = Object.fromEntries(Object.entries(loaded.fields ?? {}).filter(([, value]) => value !== undefined))
  return {
    clean: { body: keepRealtimeFinalNewline(result?.canonical ?? loaded.body, finalNewline), fields },
    finalNewline,
    issues: result?.issues ?? [],
    readOnly: result?.writable === false,
  }
}

function guardStatus(guard: DocumentGuard): { error: string | null, issues: RealtimeIssue[] } {
  return { error: guard.readOnly ? readOnlyDocumentMessage : null, issues: guard.issues }
}

interface RealtimeRoomSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> }
}

function documentTables(sql: RealtimeRoomSql): boolean {
  sql.exec("CREATE TABLE IF NOT EXISTS vitehub_realtime_documents (room_key TEXT PRIMARY KEY, epoch TEXT NOT NULL, digest TEXT, dirty INTEGER NOT NULL, update_blob BLOB NOT NULL)")
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

function parseRoomPath(url: string): { definitionName: string, documentId: string, searchParams: URLSearchParams, workspaceEvents: boolean } {
  const parsed = new URL(url)
  const path = parsed.pathname
  if (!path.startsWith(routePrefix)) throw new HTTPError({ status: 404 })
  let parts: string[]
  try {
    parts = path.slice(routePrefix.length).split("/").map(decodeURIComponent)
  }
  catch {
    throw new HTTPError({ status: 400, message: "Realtime route components must be valid URL encoding." })
  }
  const [definitionName, ...documentParts] = parts
  if (!definitionName || documentParts.length === 0 || documentParts.some(part => !part)) {
    throw new HTTPError({ status: 400, message: "Realtime definition and document path are required." })
  }
  const documentId = documentParts.join("/")
  try {
    if (normalizeSafeWorkspacePath(documentId) !== documentId) throw realtimeErrorDiagnostics.REALTIME_R0007()
  }
  catch {
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Identities and stored rows cross untyped boundaries.
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

async function identify(request: Request, event: unknown, definitionName: string, definition: RealtimeDefinition): Promise<RealtimeUser | null> {
  if (definition.identify) {
    const origin = request.headers.get("origin")
    // Browsers send Origin on WebSocket handshakes and POSTs. Reject cross-site use of ambient credentials.
    if (origin && origin !== new URL(request.url).origin) throw new HTTPError({ status: 403, message: "Realtime requests must come from the application origin." })
    const user = toRealtimeUser(await definition.identify({ definition: definitionName, event, request }))
    if (definition.auth && !user) throw new HTTPError({ status: 401 })
    return user
  }
  if (!definition.auth) return null
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

async function allows(
  definition: RealtimeDefinition,
  context: { definition: string, documentId: string | null, event: unknown, mode: "read" | "write", request: Request, user: RealtimeUser | null },
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

/** The `$DurableObject` namespace binding that holds Realtime rooms on Cloudflare. */
export interface RealtimeDurableObjectNamespace {
  get(id: unknown): { fetch(request: Request): Promise<Response> }
  idFromName(name: string): unknown
}

export interface RealtimeRefreshOptions {
  /** On Cloudflare, the `$DurableObject` binding. Without it, only rooms of this process refresh. */
  durableObjects?: RealtimeDurableObjectNamespace
}

/**
 * Tells the open room of a document that its stored copy changed outside the room, such as a save by an Agent or the
 * CLI. A room without unsaved edits re-seeds at once and resets its clients. A room with unsaved edits finds the change
 * at its next save, which also re-seeds it. A room that is not open loads the stored copy when it opens. Resolves
 * whether a room re-seeded. It never throws: a failed refresh leaves the next save to find the change.
 */
export async function refreshRealtimeDocument(definition: string, documentId: string, options: RealtimeRefreshOptions = {}): Promise<boolean> {
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
  const binding = options.durableObjects
  if (!binding) return reseeded
  try {
    const room = documentId.split("/").map(encodeURIComponent).join("/")
    const response = await binding.get(binding.idFromName(durableRoomsInstance)).fetch(new Request(
      `https://vitehub.internal${routePrefix}${encodeURIComponent(definition)}/${room}?document=refresh`,
      { method: "POST", headers: { [internalRefreshHeader]: "1" } },
    ))
    const result: unknown = response.ok ? await response.json() : undefined
    return reseeded || (result instanceof Object && "reseeded" in result && result.reseeded === true)
  }
  catch {
    return reseeded
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

export function createRealtimeHandler(registry: RealtimeRegistry): RealtimeHandler {
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

  function resolveCloudflare(event: { context: Record<string, unknown>, req: Request }): Record<string, unknown> | undefined {
    const runtime = (event.req as Request & { runtime?: { cloudflare?: Record<string, unknown> } }).runtime?.cloudflare
    const platform = (event.context._platform as { cloudflare?: Record<string, unknown> } | undefined)?.cloudflare
    if (!runtime) return platform
    if (!platform) return runtime
    return {
      ...runtime,
      ...platform,
      context: runtime.context ?? platform.context,
      env: platform.env ?? runtime.env,
    }
  }

  async function forwardToCloudflareDurableObject(event: { context: Record<string, unknown>, req: Request }): Promise<Response | undefined> {
    const cloudflare = resolveCloudflare(event)
    const context = cloudflare?.context
    const binding = (cloudflare?.env as Record<string, unknown> | undefined)?.$DurableObject as {
      get(id: unknown): { fetch(request: Request): Promise<Response> }
      idFromName(name: string): unknown
    } | undefined
    if (!binding || (typeof context === "object" && context !== null && "storage" in context)) return
    let request = event.req
    if (request.headers.has(internalRefreshHeader)) {
      // Only refreshRealtimeDocument() may send it, straight to the Durable Object.
      const headers = new Headers(request.headers)
      headers.delete(internalRefreshHeader)
      request = new Request(request, { headers })
    }
    return await binding.get(binding.idFromName(durableRoomsInstance)).fetch(request)
  }

  function resolveRealtimeRoomSql(event: { context: Record<string, unknown>, req: Request }): RealtimeRoomSql | undefined {
    const context = resolveCloudflare(event)?.context as { storage?: { sql?: RealtimeRoomSql } } | undefined
    return context?.storage?.sql
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

  function getEventsRoom(definitionName: string): Promise<EventsRoom> {
    const key = JSON.stringify([definitionName, { workspaceEvents: true }])
    return openRoom(key, undefined, async () => {
      const document = new Y.Doc()
      const awareness = new awarenessProtocol.Awareness(document)
      awareness.setLocalState(null)
      return {
        awareness,
        awarenessOwners: createRealtimeAwarenessOwners(),
        channel: `vitehub:realtime:${key}`,
        document,
        key,
        kind: "events",
        peers: new Set(),
      }
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
    document.on("update", (update: Uint8Array, origin: unknown) => {
      if (room.document !== document) return
      persistRoomUpdate(room, update, origin !== serverOrigin)
      const message = encodeSyncUpdate(update)
      const sender = roomPeer(room, origin)
      if (sender) sender.publish(room.channel, message)
      else for (const peer of room.peers) peer.send(message)
      if (origin !== serverOrigin) markDirty(room, sender && room.peerUsers.get(sender))
    })
  }

  function replaceDocument(room: DocumentRoom, document: Y.Doc): void {
    room.document = document
    room.awareness = createAwareness(document)
    room.awarenessOwners = createRealtimeAwarenessOwners()
    listen(room, document)
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
      const context: RealtimeDocumentContext = { authority: sql ? "cloudflare" : "memory", definition: definitionName, documentId }
      const editor = resolved.editor(context)
      const loaded = await resolved.adapter.load(context)
      const guard = await verifyDocument(editor, loaded)
      if (sql) {
        const clientUpdateColumn = documentTables(sql)
        migrateLegacyDocument(sql, key, clientUpdateColumn)
      }
      const stored = sql?.exec("SELECT epoch, digest, dirty, update_blob FROM vitehub_realtime_documents WHERE room_key = ?", key).toArray()[0]
      const storedDigest = text(stored?.digest) ?? null
      const storedEpoch = text(stored?.epoch)
      const storedState = storedUpdate(stored?.update_blob)
      // Restore persisted Yjs state while it still describes the stored document. A different
      // digest means an external write: seed a new room so stale client state cannot merge back.
      const restores = !!sql && !!storedState && !!storedEpoch && storedDigest === loaded.digest
      let document: Y.Doc
      let persistedUpdates = 0
      let dirty = false
      if (restores) {
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
        channel: `vitehub:realtime:${key}`,
        context,
        destroyed: false,
        digest: loaded.digest,
        document,
        dirty,
        editor,
        editors: new Map(),
        epoch: restores && storedEpoch ? storedEpoch : crypto.randomUUID(),
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
      listen(room, document)
      if (sql && !restores) persistRoom(room)
      if (dirty) scheduleSave(room)
      return room
    })
  }

  function persistRoom(room: DocumentRoom): void {
    if (!room.sql) return
    // ponytail: full snapshots keep recovery atomic; use compacted update logs when document write cost becomes measurable.
    room.sql.exec(
      "INSERT OR REPLACE INTO vitehub_realtime_documents (room_key, epoch, digest, dirty, update_blob) VALUES (?, ?, ?, ?, ?)",
      room.key,
      room.epoch,
      room.digest,
      room.dirty ? 1 : 0,
      Uint8Array.from(Y.encodeStateAsUpdate(room.document)).buffer,
    )
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
    inactiveMemoryRoomKeys.delete(room.key)
    memoryRoomKeys.delete(room.key)
  }

  /** Releases an idle room: durable rooms leave memory; clean memory rooms become reclaimable. */
  function releaseRoom(room: Room): void {
    if (room.peers.size > 0) return
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

  async function reseedRoom(room: DocumentRoom, reason: RealtimeResetReason, loaded?: RealtimeLoadedDocument, preserveEdits = false): Promise<boolean> {
    const revision = room.revision
    const source = loaded ?? await room.resolved.adapter.load(room.context)
    const guard = await verifyDocument(room.editor, source)
    const next = await seedDocument(room.editor, source, guard)
    // Verification and seeding are asynchronous. Preserve edits that arrive while they run.
    // A client update can arrive during verification or seeding. The revision
    // guard applies to every reseed, including conflict recovery, so that the
    // live document is never replaced after a concurrent edit.
    if (room.destroyed || room.revision !== revision || (preserveEdits && room.dirty)) return false
    const previous = { awareness: room.awareness, document: room.document }
    const peers = [...room.peers]
    // Keep peers and writers tracked until their close callbacks run so the room is released when reset sockets close.
    room.epoch = crypto.randomUUID()
    room.digest = source.digest
    room.guard = guard
    room.dirty = false
    room.editors.clear()
    room.firstDirtyAt = undefined
    room.retryDelay = 0
    if (room.idleTimer) clearTimeout(room.idleTimer)
    room.idleTimer = undefined
    replaceDocument(room, next)
    previous.awareness.destroy()
    previous.document.destroy()
    persistRoom(room)
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
      const written = await readRealtimeYDoc(editor, submitted)
      const document = { ...written, body: keepRealtimeFinalNewline(written.body, room.guard.finalNewline) }
      const { clean } = room.guard
      if (room.digest !== null && document.body === clean.body && realtimeJsonEqual(document.fields, clean.fields)) {
        // The edits cancel out, or only change the codec's own form of the stored document: write nothing.
        writeRealtimeStatus(room.document, { error: null }, serverOrigin)
        finishSave()
        return { ...readRealtimeStatus(room.document), document }
      }
      const readsBack = await realtimeCodecReadsBack(editor, submitted, written.body)
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
        if (update.byteLength > 0) Y.applyUpdate(room.document, update, serverOrigin)
      }
      const status = {
        digest: result.digest,
        error: null,
        issues: readsBack ? result.issues ?? [] : [...result.issues ?? [], codecReadBackIssue],
        savedAt: new Date().toISOString(),
        savedBy: user ?? null,
      }
      writeRealtimeStatus(room.document, status, serverOrigin)
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

  async function refreshRoom(room: DocumentRoom): Promise<{ digest: string | null, reseeded: boolean }> {
    const revision = room.revision
    const loaded = await room.resolved.adapter.load(room.context)
    // A client may edit while the adapter is loading. Preserve that live edit
    // and let the normal save path reconcile the external change.
    if (room.dirty || room.revision !== revision) return { digest: room.digest, reseeded: false }
    if (loaded.digest === room.digest) return { digest: room.digest, reseeded: false }
    const reseeded = await reseedRoom(room, "source-changed", loaded, true)
    return { digest: room.digest, reseeded }
  }

  /** Refreshes an open room without unsaved edits. A dirty room finds the outside change at its next save. */
  async function refreshOpenRoom(definitionName: string, documentId: string): Promise<boolean> {
    const pending = rooms.get(realtimeRoomKey(definitionName, documentId))
    const room = pending ? await pending.catch(() => undefined) : undefined
    if (!room || room.kind !== "document" || room.destroyed) return false
    return await enqueue(room, async () => !room.dirty && (await refreshRoom(room)).reseeded)
  }
  localRefreshers().add(new WeakRef(refreshOpenRoom))

  async function checkpointRoom(room: DocumentRoom, user: RealtimeUser | null): Promise<RealtimeCheckpoint> {
    const { adapter, definition } = room.resolved
    const configured = definition.history?.checkpoint
    const saved = (await saveRoom(room, "request", true))!
    if (!saved.digest) throw realtimeErrorDiagnostics.REALTIME_R0008({ message: "Realtime checkpoints require a stored document digest." })
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

  async function requestContext(event: { context: Record<string, unknown>, req: Request }) {
    const { definitionName, documentId, searchParams, workspaceEvents } = parseRoomPath(event.req.url)
    const definition = await getDefinition(definitionName)
    const resolved = resolveRealtimeDefinition(definition)
    const user = await identify(event.req, event, definitionName, definition)
    const access = (mode: "read" | "write", id: string | null = workspaceEvents ? null : documentId) =>
      allows(definition, { definition: definitionName, documentId: id, event, mode, request: event.req, user })
    return { access, definitionName, documentId, resolved, searchParams, user, workspaceEvents }
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
    if (action === "checkpoint" && (!request.resolved.definition.history?.checkpoint || !request.resolved.adapter.checkpoint)) {
      throw new HTTPError({ status: 404 })
    }
    if (!(await request.access("read")) || (action !== "refresh" && !(await request.access("write")))) {
      throw new HTTPError({ status: 403 })
    }
    const state = action === "refresh" ? undefined : await readRealtimeRequestState(event.req)
    if (state && !state.byteLength) throw new HTTPError({ status: 400, message: "Realtime document state is required." })
    const room = await getDocumentRoom(request.definitionName, request.documentId, request.resolved, resolveRealtimeRoomSql(event))
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
    const writable = !request.workspaceEvents && await request.access("write")
    const identity: RealtimeIdentity | undefined = request.user ? createRealtimeIdentity({ ...request.user }) : undefined
    const room: Room = request.workspaceEvents
      ? await getEventsRoom(request.definitionName)
      : await getDocumentRoom(request.definitionName, request.documentId, request.resolved, resolveRealtimeRoomSql(event))
    const clientEpoch = request.searchParams.get("epoch")

    function leave(peer: WebSocketPeer) {
      if (terminalPeers.has(peer)) clearHeldUpdates(peer)
      else applyHeldUpdates(peer)
      if (!room.peers.delete(peer)) return
      const pendingAwareness = peerPendingAwareness.get(peer)
      if (pendingAwareness) clearTimeout(pendingAwareness.timer)
      peerPendingAwareness.delete(peer)
      const clients = room.awarenessOwners.release(peer)
      if (clients.length) {
        awarenessProtocol.removeAwarenessStates(room.awareness, clients, peer)
        peer.publish(room.channel, encodeAwarenessState(room.awareness, clients))
        room.awareness = compactRealtimeAwareness(room.awareness)
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
        const readOnly = room.guard.readOnly ? readOnlyDocumentRejection : !writable
        const response = applyRealtimeSyncMessage(data, room.document, peer, { readOnly })
        if (response) peer.send(response)
      }
      catch (error) {
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
      if (clients.length) peer.publish(room.channel, encodeAwarenessState(room.awareness, clients))
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
        if (room.kind === "document") {
          const reason: RealtimeReadOnlyReason | undefined = room.guard.readOnly ? "document" : writable ? undefined : "access"
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
        if (!room.peers.has(peer)) return
        const data = message.uint8Array()
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
          if (room.kind !== "events") {
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
          peer.publish(room.channel, encodeWorkspaceChange(change))
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
              peer.close(4400, "Document updates cannot use the workspace room.")
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
