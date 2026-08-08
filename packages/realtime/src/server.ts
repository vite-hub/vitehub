import { Editor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap"
import { getAuthForRequest } from "@vite-hub/auth/server"
import { isWorkspaceConflict, useWorkspace } from "@vite-hub/workspace"
import { resetWorkspaceStoreCache } from "@vite-hub/workspace/runtime"
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
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, messageAwareness, messageQueryAwareness, messageWorkspaceChange, readAwarenessClientIds, workspaceRoomId } from "./protocol.ts"

const routePrefix = "/api/_vitehub/realtime/"
const maxMessageBytes = 1024 * 1024
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
  document: Y.Doc
  key: string
  pendingCheckpoint?: {
    message: string
    workspace: Pick<WritableWorkspaceFacade, "history">
  }
  peers: Set<WebSocketPeer>
}

export function claimAwarenessClientIds(owners: Map<number, object>, peer: object, clients: number[]): void {
  for (const client of clients) {
    const owner = owners.get(client)
    if (owner && owner !== peer) throw new AwarenessOwnershipConflict()
  }
  for (const client of clients) owners.set(client, peer)
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

function encodeSyncState(document: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep2(encoder, document)
  return encoding.toUint8Array(encoder)
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

  async function forwardToCloudflareDurableObject(event: { context: Record<string, unknown>, req: Request }): Promise<Response | undefined> {
    const runtime = (event.req as Request & { runtime?: { cloudflare?: Record<string, unknown> } }).runtime?.cloudflare
    const platform = (event.context._platform as { cloudflare?: Record<string, unknown> } | undefined)?.cloudflare
    const cloudflare = platform || runtime
    const context = cloudflare?.context
    const binding = (cloudflare?.env as Record<string, unknown> | undefined)?.$DurableObject as {
      get(id: unknown): { fetch(request: Request): Promise<Response> }
      idFromName(name: string): unknown
    } | undefined
    if (!binding || (typeof context === "object" && context !== null && "storage" in context)) return
    return await binding.get(binding.idFromName("server")).fetch(event.req)
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

  async function getRoom(definitionName: string, documentId: string, definition: RealtimeDefinition): Promise<Room> {
    const key = `${definitionName}:${documentId}`
    let room = rooms.get(key)
    if (!room) {
      room = (async () => {
        const workspaceDocument = documentId !== workspaceRoomId
        const workspace = workspaceDocument ? useWorkspace(definition.document.workspace) : undefined
        const stat = workspace ? await workspace.fs.stat(documentId) : undefined
        const markdown = workspace ? await workspace.fs.readFile(documentId, { encoding: "utf8" }) : ""
        const document = workspaceDocument ? markdownToYDoc(markdown) : new Y.Doc()
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
        }
        value.document.on("update", (update: Uint8Array, origin: unknown) => {
          if (origin && typeof origin === "object" && "publish" in origin) {
            (origin as WebSocketPeer).publish(value.channel, encodeSyncUpdate(update))
          }
        })
        return value
      })()
      rooms.set(key, room)
      room.catch(() => rooms.delete(key))
    }
    return await room
  }

  function evictRoom(room: Room): void {
    if (room.peers.size > 0 || room.checkpoint || room.pendingCheckpoint) return
    room.awareness.destroy()
    room.document.destroy()
    rooms.delete(room.key)
  }

  async function checkpointRoom(documentId: string, definition: RealtimeDefinition, room: Room): Promise<WorkspaceSnapshot> {
    const configured = definition.history?.checkpoint
    if (!configured) throw new HTTPError({ status: 404 })
    if (room.checkpoint) return await room.checkpoint

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
      return snapshot
    })()

    room.checkpoint = checkpoint
    try {
      return await checkpoint
    }
    finally {
      if (room.checkpoint === checkpoint) room.checkpoint = undefined
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
    const room = await getRoom(definitionName, documentId, definition)
    return await checkpointRoom(documentId, definition, room)
  })

  const websocketHandler = defineWebSocketHandler(async (event) => {
    const { definitionName, documentId } = parseRoomPath(event.req.url)
    const definition = await getDefinition(definitionName)
    const identity = await authorize(event.req, definition.auth, event)
    const room = await getRoom(definitionName, documentId, definition)

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
        peer.send(encodeSyncState(room.document))
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
          resetWorkspaceStoreCache()
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
          try {
            clients = readAwarenessClientIds(update)
            claimAwarenessClientIds(room.awarenessClientOwners as Map<number, object>, peer, clients)
            if (identity) update = bindAwarenessIdentity(update, identity)
            const ownedClients = peerAwarenessClients.get(peer) || new Set<number>()
            for (const client of clients) ownedClients.add(client)
            peerAwarenessClients.set(peer, ownedClients)
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, peer)
          }
          catch (error) {
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
