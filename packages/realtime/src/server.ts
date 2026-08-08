import { Editor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap"
import { getAuthForRequest } from "@vite-hub/auth/server"
import { isWorkspaceConflict, useWorkspace } from "@vite-hub/workspace"
import { HTTPError, defineEventHandler, defineWebSocketHandler } from "h3"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { WorkspaceSnapshot, WritableWorkspaceFacade } from "@vite-hub/workspace"
import type { WebSocketMessage, WebSocketPeer } from "h3"
import type { RealtimeIdentity } from "./presence.ts"
import type { RealtimeDefinition, RealtimeRegistry } from "./types.ts"
import { createRealtimeIdentity } from "./presence.ts"
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, maxAwarenessClients, messageAwareness, messageQueryAwareness, messageWorkspaceChange, readAwarenessClientIds, workspaceRoomId } from "./protocol.ts"

const routePrefix = "/api/_vitehub/realtime/"
const maxMessageBytes = 1024 * 1024
const memoryRoomGraceMs = 30_000
const messageSync = 0
const fragmentName = "default"

const editorExtensions = [
  StarterKit.configure({ undoRedo: false }),
  Image,
  TableKit,
  Markdown,
]

export function markdownToYDoc(markdown: string): Y.Doc {
  const editor = new Editor({
    content: markdown || { type: "doc", content: [{ type: "paragraph" }] },
    contentType: "markdown",
    extensions: editorExtensions,
  })
  try {
    return prosemirrorJSONToYDoc(editor.schema, editor.getJSON(), fragmentName)
  }
  finally {
    editor.destroy()
  }
}

export function yDocToMarkdown(document: Y.Doc): string {
  const editor = new Editor({
    content: yDocToProsemirrorJSON(document, fragmentName),
    extensions: editorExtensions,
  })
  try {
    return editor.getMarkdown()
  }
  finally {
    editor.destroy()
  }
}

interface Room {
  awareness: awarenessProtocol.Awareness
  awarenessClientOwners: Map<number, WebSocketPeer>
  baselineDigest?: string
  channel: string
  checkpoint?: Promise<WorkspaceSnapshot>
  checkpointStateVector?: Uint8Array
  document: Y.Doc
  evictionTimer?: ReturnType<typeof setTimeout>
  key: string
  pendingCheckpoint?: {
    message: string
    workspace: Pick<WritableWorkspaceFacade, "history">
  }
  peers: Set<WebSocketPeer>
  sql?: RealtimeRoomSql
}

interface RealtimeRoomSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> }
}

export function claimAwarenessClientIds(owners: Map<number, object>, peer: object, clients: number[]): number[] {
  for (const client of clients) {
    const owner = owners.get(client)
    if (owner && owner !== peer) throw new AwarenessOwnershipConflict()
  }
  const ownedClients = new Set(
    [...owners].filter(([, owner]) => owner === peer).map(([client]) => client),
  )
  for (const client of clients) ownedClients.add(client)
  if (ownedClients.size > maxAwarenessClients) {
    throw new TypeError("Peer owns too many awareness clients.")
  }
  const claimed = clients.filter(client => !owners.has(client))
  for (const client of clients) owners.set(client, peer)
  return claimed
}

export function realtimeRoomKey(definitionName: string, documentId: string): string {
  return JSON.stringify([definitionName, documentId])
}

class AwarenessOwnershipConflict extends TypeError {
  constructor() {
    super("Awareness client id is already owned by another peer.")
  }
}

export function bindAwarenessIdentity(update: Uint8Array, identity: RealtimeIdentity): Uint8Array {
  return awarenessProtocol.modifyAwarenessUpdate(update, (state: unknown) => {
    if (state === null) return null
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError("Invalid awareness state.")
    return { ...state, user: identity }
  })
}

export async function writeRealtimeDocument(
  workspace: Pick<WritableWorkspaceFacade, "fs">,
  documentId: string,
  document: Y.Doc,
  ifDigest: string | null,
): Promise<void> {
  await workspace.fs.writeFile(documentId, yDocToMarkdown(document), { ifDigest })
}

function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function encodeSyncStep1(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, document)
  return encoding.toUint8Array(encoder)
}

export function matchesRealtimeStateVector(document: Y.Doc, expected: Uint8Array): boolean {
  const actual = Y.encodeStateVector(document)
  return matchesBytes(actual, expected)
}

function matchesBytes(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
  return !!actual && actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

function storedUpdate(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

export function restoreRealtimeDocument(markdown: string, baselineDigest: string | undefined, stored: Record<string, unknown> | undefined): Y.Doc {
  const update = storedUpdate(stored?.update_blob)
  const storedDigest = typeof stored?.baseline_digest === "string" ? stored.baseline_digest : undefined
  if (!update || storedDigest !== baselineDigest) return markdownToYDoc(markdown)
  const document = new Y.Doc()
  Y.applyUpdate(document, update)
  return document
}

function encodeAwarenessState(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(encoder)
}

function parseRoomPath(url: string): { definitionName: string, documentId: string } {
  const path = new URL(url).pathname
  if (!path.startsWith(routePrefix)) throw new HTTPError({ status: 404 })
  const [definitionName, ...documentParts] = path.slice(routePrefix.length).split("/").map(decodeURIComponent)
  if (!definitionName || documentParts.length === 0 || documentParts.some(part => !part)) {
    throw new HTTPError({ status: 400, message: "Realtime definition and document path are required." })
  }
  return { definitionName, documentId: documentParts.join("/") }
}

async function authorize(request: Request, required: boolean | undefined, event: unknown): Promise<RealtimeIdentity | undefined> {
  if (!required) return
  const session = await getAuthForRequest(request, undefined, event).api.getSession({ headers: request.headers })
  if (!session?.user) throw new HTTPError({ status: 401 })
  return createRealtimeIdentity(session.user)
}

export function createRealtimeHandler(registry: RealtimeRegistry) {
  const rooms = new Map<string, Promise<Room>>()
  const peerAwarenessClients = new WeakMap<WebSocketPeer, Set<number>>()

  function resolveCloudflare(event: { context: Record<string, unknown>, req: Request }): Record<string, unknown> | undefined {
    const runtime = (event.req as Request & { runtime?: { cloudflare?: Record<string, unknown> } }).runtime?.cloudflare
    const platform = (event.context._platform as { cloudflare?: Record<string, unknown> } | undefined)?.cloudflare
    return platform || runtime
  }

  async function forwardToCloudflareDurableObject(event: { context: Record<string, unknown>, req: Request }): Promise<Response | undefined> {
    const cloudflare = resolveCloudflare(event)
    const context = cloudflare?.context
    const binding = (cloudflare?.env as Record<string, unknown> | undefined)?.$DurableObject as {
      get(id: unknown): { fetch(request: Request): Promise<Response> }
      idFromName(name: string): unknown
    } | undefined
    if (!binding || (typeof context === "object" && context !== null && "storage" in context)) return
    return await binding.get(binding.idFromName("server")).fetch(event.req)
  }

  function resolveRealtimeRoomSql(event: { context: Record<string, unknown>, req: Request }): RealtimeRoomSql | undefined {
    const context = resolveCloudflare(event)?.context as { storage?: { sql?: RealtimeRoomSql } } | undefined
    return context?.storage?.sql
  }

  async function getDefinition(definitionName: string): Promise<RealtimeDefinition> {
    const module = await registry[definitionName]?.()
    if (!module) throw new HTTPError({ status: 404, message: `Unknown realtime definition ${JSON.stringify(definitionName)}.` })
    const definition = module.default
    if (definition.engine !== "yjs" || definition.document.format !== "tiptap-markdown") {
      throw new HTTPError({ status: 500, message: "Unsupported realtime definition." })
    }
    return definition
  }

  async function getRoom(definitionName: string, documentId: string, definition: RealtimeDefinition, sql?: RealtimeRoomSql): Promise<Room> {
    const key = realtimeRoomKey(definitionName, documentId)
    let room = rooms.get(key)
    if (!room) {
      room = (async () => {
        const workspaceDocument = documentId !== workspaceRoomId
        const workspace = workspaceDocument ? useWorkspace(definition.document.workspace) : undefined
        const stat = workspace ? await workspace.fs.stat(documentId) : undefined
        const markdown = workspace ? await workspace.fs.readFile(documentId, { encoding: "utf8" }) : ""
        if (workspaceDocument && sql) {
          sql.exec("CREATE TABLE IF NOT EXISTS vitehub_realtime_rooms (room_key TEXT PRIMARY KEY, baseline_digest TEXT, update_blob BLOB NOT NULL)")
        }
        const stored = workspaceDocument && sql
          ? sql.exec("SELECT baseline_digest, update_blob FROM vitehub_realtime_rooms WHERE room_key = ?", key).toArray()[0]
          : undefined
        const document = workspaceDocument ? restoreRealtimeDocument(markdown, stat?.digest, stored) : new Y.Doc()
        const awareness = new awarenessProtocol.Awareness(document)
        awareness.setLocalState(null)
        const value: Room = {
          awareness,
          awarenessClientOwners: new Map(),
          baselineDigest: stat?.digest,
          channel: `vitehub:realtime:${key}`,
          document,
          key,
          peers: new Set(),
          sql: workspaceDocument ? sql : undefined,
        }
        value.document.on("update", (update: Uint8Array, origin: unknown) => {
          persistRoom(value)
          if (origin && typeof origin === "object" && "publish" in origin) {
            (origin as WebSocketPeer).publish(value.channel, encodeSyncUpdate(update))
          }
        })
        return value
      })()
      rooms.set(key, room)
      room.catch(() => rooms.delete(key))
    }
    const value = await room
    if (value.evictionTimer) {
      clearTimeout(value.evictionTimer)
      value.evictionTimer = undefined
    }
    return value
  }

  function persistRoom(room: Room): void {
    if (!room.sql) return
    // ponytail: full snapshots keep recovery atomic; use compacted update logs when document write cost becomes measurable.
    room.sql.exec(
      "INSERT OR REPLACE INTO vitehub_realtime_rooms (room_key, baseline_digest, update_blob) VALUES (?, ?, ?)",
      room.key,
      room.baselineDigest ?? null,
      Uint8Array.from(Y.encodeStateAsUpdate(room.document)).buffer,
    )
  }

  function evictRoom(room: Room): void {
    if (room.peers.size > 0 || room.checkpoint || room.pendingCheckpoint) return
    if (!room.sql && !room.evictionTimer) {
      room.evictionTimer = setTimeout(() => {
        room.evictionTimer = undefined
        if (room.peers.size === 0 && !room.checkpoint && !room.pendingCheckpoint) destroyRoom(room)
      }, memoryRoomGraceMs)
      return
    }
    if (!room.sql) return
    destroyRoom(room)
  }

  function destroyRoom(room: Room): void {
    if (room.evictionTimer) clearTimeout(room.evictionTimer)
    room.awareness.destroy()
    room.document.destroy()
    rooms.delete(room.key)
  }

  async function checkpointRoom(documentId: string, definition: RealtimeDefinition, room: Room, stateVector: Uint8Array): Promise<WorkspaceSnapshot> {
    const configured = definition.history?.checkpoint
    if (!configured) throw new HTTPError({ status: 404 })
    if (room.checkpoint) {
      const active = room.checkpoint
      if (matchesBytes(room.checkpointStateVector, stateVector)) return await active
      await active
      return await checkpointRoom(documentId, definition, room, stateVector)
    }

    const checkpoint = (async () => {
      let pending = room.pendingCheckpoint
      if (!pending) {
        const workspace = useWorkspace(definition.document.workspace, { mode: "write" })
        const message = typeof configured === "object" && configured.message
          ? configured.message
          : `docs: checkpoint ${documentId}`
        try {
          await writeRealtimeDocument(workspace, documentId, room.document, room.baselineDigest ?? null)
        }
        catch (error) {
          if (isWorkspaceConflict(error)) {
            throw new HTTPError({ status: 409, message: "The document changed in Workspace after this realtime room opened." })
          }
          throw error
        }
        pending = { message, workspace }
        room.pendingCheckpoint = pending
      }

      let snapshot: WorkspaceSnapshot
      try {
        snapshot = await pending.workspace.history.checkpoint({ message: pending.message })
      }
      catch (error) {
        if (isWorkspaceConflict(error)) throw new HTTPError({ status: 409, message: "The Workspace changed while checkpointing this realtime document." })
        throw error
      }
      if (room.pendingCheckpoint === pending) room.pendingCheckpoint = undefined
      room.baselineDigest = snapshot.entries[documentId]?.digest
      persistRoom(room)
      return snapshot
    })()

    room.checkpoint = checkpoint
    room.checkpointStateVector = stateVector
    try {
      return await checkpoint
    }
    finally {
      if (room.checkpoint === checkpoint) {
        room.checkpoint = undefined
        room.checkpointStateVector = undefined
      }
      evictRoom(room)
    }
  }

  const httpHandler = defineEventHandler(async (event) => {
    if (event.req.method !== "POST" || new URL(event.req.url).searchParams.get("history") !== "checkpoint") {
      throw new HTTPError({ status: 405 })
    }
    const { definitionName, documentId } = parseRoomPath(event.req.url)
    if (documentId === workspaceRoomId) throw new HTTPError({ status: 400, message: "Workspace events cannot be checkpointed." })
    const definition = await getDefinition(definitionName)
    await authorize(event.req, definition.auth, event)
    const room = await getRoom(definitionName, documentId, definition, resolveRealtimeRoomSql(event))
    const contentLength = Number(event.req.headers.get("content-length") || 0)
    if (contentLength > maxMessageBytes) throw new HTTPError({ status: 413, message: "Realtime state vector exceeds 1 MiB." })
    const stateVector = new Uint8Array(await event.req.arrayBuffer())
    if (!stateVector.byteLength) throw new HTTPError({ status: 400, message: "A realtime state vector is required." })
    if (stateVector.byteLength > maxMessageBytes) throw new HTTPError({ status: 413, message: "Realtime state vector exceeds 1 MiB." })
    if (!matchesRealtimeStateVector(room.document, stateVector)) {
      throw new HTTPError({
        status: 409,
        message: "The realtime document is still syncing.",
        data: { code: "REALTIME_SYNC_PENDING" },
      })
    }
    return await checkpointRoom(documentId, definition, room, stateVector)
  })

  const websocketHandler = defineWebSocketHandler(async (event) => {
    const { definitionName, documentId } = parseRoomPath(event.req.url)
    const definition = await getDefinition(definitionName)
    const identity = await authorize(event.req, definition.auth, event)
    const room = await getRoom(definitionName, documentId, definition, resolveRealtimeRoomSql(event))

    function leave(peer: WebSocketPeer) {
      if (!room.peers.delete(peer)) return
      const clients = [...(peerAwarenessClients.get(peer) || [])]
      peerAwarenessClients.delete(peer)
      if (clients.length) {
        for (const client of clients) {
          if (room.awarenessClientOwners.get(client) === peer) room.awarenessClientOwners.delete(client)
        }
        awarenessProtocol.removeAwarenessStates(room.awareness, clients, peer)
        peer.publish(room.channel, encodeAwarenessState(room.awareness, clients))
      }
      peer.unsubscribe(room.channel)
      evictRoom(room)
    }

    return {
      open(peer) {
        room.peers.add(peer)
        peer.subscribe(room.channel)
        peer.send(encodeSyncStep1(room.document))
        const clients = [...room.awareness.getStates().keys()]
        if (clients.length) peer.send(encodeAwarenessState(room.awareness, clients))
      },
      message(peer, message: WebSocketMessage) {
        const data = message.uint8Array()
        if (data.byteLength > maxMessageBytes) {
          peer.close(4400, "Realtime message exceeds 1 MiB.")
          return
        }
        const decoder = decoding.createDecoder(data)
        const messageType = decoding.readVarUint(decoder)
        if (messageType === messageWorkspaceChange) {
          if (documentId !== workspaceRoomId) {
            peer.close(4400, "Workspace changes require the workspace room.")
            return
          }
          const change = decodeWorkspaceChangePayload(decoder)
          if (!change) {
            peer.close(4400, "Invalid workspace change.")
            return
          }
          peer.publish(room.channel, encodeWorkspaceChange(change))
          return
        }
        if (messageType === messageQueryAwareness) {
          const clients = [...room.awareness.getStates().keys()]
          if (clients.length) peer.send(encodeAwarenessState(room.awareness, clients))
          return
        }
        if (messageType === messageAwareness) {
          let update = decoding.readVarUint8Array(decoder)
          let clients: number[]
          let claimed: number[] = []
          try {
            clients = readAwarenessClientIds(update)
            claimed = claimAwarenessClientIds(room.awarenessClientOwners as Map<number, object>, peer, clients)
            if (identity) update = bindAwarenessIdentity(update, identity)
            const ownedClients = peerAwarenessClients.get(peer) || new Set<number>()
            for (const client of clients) ownedClients.add(client)
            peerAwarenessClients.set(peer, ownedClients)
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, peer)
          }
          catch (error) {
            for (const client of claimed) {
              if (room.awarenessClientOwners.get(client) === peer) room.awarenessClientOwners.delete(client)
            }
            peer.close(error instanceof AwarenessOwnershipConflict ? 4500 : 4400, "Invalid awareness update.")
            return
          }
          peer.publish(room.channel, identity ? encodeAwarenessState(room.awareness, clients) : data)
          return
        }
        if (messageType !== messageSync) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, room.document, peer)
        if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder))
      },
      close(peer) {
        leave(peer)
      },
      error(peer) {
        leave(peer)
      },
    }
  })

  return defineEventHandler(async (event) => {
    const forwarded = await forwardToCloudflareDurableObject(event)
    if (forwarded) return forwarded
    return event.req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? websocketHandler(event)
      : httpHandler(event)
  })
}
