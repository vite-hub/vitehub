import { Editor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap"
import { getAuthForRequest } from "@vite-hub/auth/server"
import { useWorkspace } from "@vite-hub/workspace"
import { resetWorkspaceStoreCache } from "@vite-hub/workspace/runtime"
import { HTTPError, defineEventHandler, defineWebSocketHandler } from "h3"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import type { WorkspaceSnapshot, WritableWorkspaceFacade } from "@vite-hub/workspace"
import type { WebSocketMessage, WebSocketPeer } from "h3"
import type { RealtimeDefinition, RealtimeRegistry } from "./types.ts"
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, messageWorkspaceChange, workspaceRoomId } from "./protocol.ts"

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
  baselineDigest?: string
  channel: string
  checkpoint?: Promise<WorkspaceSnapshot>
  document: Y.Doc
  version: number
}

export async function checkpointRealtimeDocument(
  workspace: Pick<WritableWorkspaceFacade, "fs" | "history">,
  documentId: string,
  document: Y.Doc,
  message: string,
): Promise<WorkspaceSnapshot> {
  await workspace.fs.writeFile(documentId, yDocToMarkdown(document))
  return await workspace.history.checkpoint({ message })
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

function parseRoomPath(url: string): { definitionName: string, documentId: string } {
  const path = new URL(url).pathname
  if (!path.startsWith(routePrefix)) throw new HTTPError({ status: 404 })
  const [definitionName, ...documentParts] = path.slice(routePrefix.length).split("/").map(decodeURIComponent)
  if (!definitionName || documentParts.length === 0 || documentParts.some(part => !part)) {
    throw new HTTPError({ status: 400, message: "Realtime definition and document path are required." })
  }
  return { definitionName, documentId: documentParts.join("/") }
}

async function authorize(request: Request, required: boolean | undefined, event: unknown): Promise<void> {
  if (!required) return
  const session = await getAuthForRequest(request, undefined, event).api.getSession({ headers: request.headers })
  if (!session?.user) throw new HTTPError({ status: 401 })
}

export function createRealtimeHandler(registry: RealtimeRegistry) {
  const rooms = new Map<string, Promise<Room>>()

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
        const value: Room = {
          baselineDigest: stat?.digest,
          channel: `vitehub:realtime:${key}`,
          document: workspaceDocument ? markdownToYDoc(markdown) : new Y.Doc(),
          version: 0,
        }
        value.document.on("update", (update: Uint8Array, origin: unknown) => {
          value.version++
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

  async function checkpointRoom(documentId: string, definition: RealtimeDefinition, room: Room): Promise<WorkspaceSnapshot> {
    const configured = definition.history?.checkpoint
    if (!configured) throw new HTTPError({ status: 404 })
    if (room.checkpoint) return await room.checkpoint

    const checkpoint = (async () => {
      const workspace = useWorkspace(definition.document.workspace, { mode: "write" })
      const current = await workspace.fs.stat(documentId)
      if (room.baselineDigest && current.digest !== room.baselineDigest) {
        throw new HTTPError({ status: 409, message: "The document changed in Workspace after this realtime room opened." })
      }

      const version = room.version
      const message = typeof configured === "object" && configured.message
        ? configured.message
        : `docs: checkpoint ${documentId}`
      const snapshot = await checkpointRealtimeDocument(workspace, documentId, room.document, message)
      room.baselineDigest = snapshot.entries[documentId]?.digest
      if (version !== room.version) {
        throw new HTTPError({ status: 409, message: "The document changed while its checkpoint was being written. Save again." })
      }
      return snapshot
    })()

    room.checkpoint = checkpoint
    try {
      return await checkpoint
    }
    finally {
      if (room.checkpoint === checkpoint) room.checkpoint = undefined
    }
  }

  const httpHandler = defineEventHandler(async (event) => {
    const forwarded = await forwardToCloudflareDurableObject(event)
    if (forwarded) return forwarded
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
    await authorize(event.req, definition.auth, event)
    const room = await getRoom(definitionName, documentId, definition)

    return {
      open(peer) {
        peer.subscribe(room.channel)
        peer.send(encodeSyncState(room.document))
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
        if (messageType !== messageSync) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, room.document, peer)
        if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder))
      },
      close(peer) {
        peer.unsubscribe(room.channel)
      },
      error(peer) {
        peer.unsubscribe(room.channel)
      },
    }
  })

  return defineEventHandler(event => event.req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ? websocketHandler(event)
    : httpHandler(event))
}
