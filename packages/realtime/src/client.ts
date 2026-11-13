import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

import { resolveRealtimeApplicationPath } from "./application-path.ts"
import { keepRealtimeSocketAlive } from "./keepalive.ts"
import { createRealtimeIdentity, getRealtimePeople } from "./presence.ts"
import {
  decodeRealtimeControlPayload,
  decodeRealtimeRequestFramePayload,
  decodeWorkspaceChangePayload,
  encodeRealtimeRequestFrame,
  encodeWorkspaceChange,
  messageAwareness,
  messageRealtimeControl,
  messageRealtimeRequest,
  messageWorkspaceChange,
  workspaceRoomId,
} from "./protocol.ts"

import type { RealtimePerson, RealtimeWorkspaceChange } from "./types.ts"

export type RealtimeRoomStatus = "connected" | "connecting" | "disconnected"

/** Answers one request from the server. Its value goes back as JSON. */
export type RealtimeRequestHandler = (body: unknown) => unknown

// A WebSocket message from the browser may be up to 1 MiB, with the frame's own bytes.
const maxAnswerBytes = 1024 * 1024 - 1024

export interface RealtimeRoomOptions {
  /** The app base path for a prebuilt client, such as `/portal/`. Defaults to the app's build-time base. */
  baseURL?: string
  /**
   * The app's origin, such as `https://app.example.com`, for a client running on another site's page. Defaults to the
   * page's own origin. The definition must let that page's origin in with `origins`.
   */
  origin?: string
  /** Query parameters sent to the definition's authorization on presence and workspace connections. */
  params?: Record<string, string>
  /**
   * The person this browser shows as. A definition with `identify` or `auth: true` replaces it with the server's
   * identity, so only public definitions show it as given.
   */
  identity?: { id: string, name?: string, image?: string }
  /** Also join the workspace events room of the definition, for `notify()` and `onChange()`. Default `false`. */
  changes?: boolean
}

export interface RealtimeRoom {
  /** The Yjs awareness of the room. Set your own fields with `setLocal()`. */
  readonly awareness: awarenessProtocol.Awareness
  /** This browser's awareness client id. */
  readonly clientId: number
  /** The people in the room, this browser included. */
  people(): RealtimePerson[]
  /** The field values that each other client set with `setLocal()`, by client id. */
  states(): Map<number, Record<string, unknown>>
  status(): RealtimeRoomStatus
  /** Sets one field of this browser's awareness state, such as a cursor. `null` removes it. */
  setLocal(field: string, value: unknown): void
  /** Sends a change hint to every other browser of the definition. Needs `changes: true`. */
  notify(change: RealtimeWorkspaceChange): void
  /** Runs when the people, their awareness fields, or the status change. Returns a function that removes it. */
  onUpdate(listener: () => void): () => void
  /** Runs for each change hint from another browser. Needs `changes: true`. Returns a function that removes it. */
  onChange(listener: (change: RealtimeWorkspaceChange) => void): () => void
  /**
   * Answers the server's `requestRealtimeRoom()` calls to this room with what `handler` returns, as JSON. A thrown
   * error, or an answer over 1 MiB, reaches the caller as `REALTIME_ROOM_REFUSED`. One handler at a time: a new one
   * replaces the last. Needs a Definition with `requests: true`. Returns a function that removes it.
   */
  onRequest(handler: RealtimeRequestHandler): () => void
  destroy(): void
}

/**
 * Joins one room of a Realtime Definition for presence: who is there and what each person shares through awareness,
 * such as a cursor. It does not edit the room document. Use it outside Vue, or when a page needs presence without an
 * editor; `useRealtimeTiptap()` from `@vite-hub/realtime/vue` is the editor client.
 */
export function connectRealtimeRoom(definition: string, documentId: string, options: RealtimeRoomOptions = {}): RealtimeRoom {
  const updateListeners = new Set<() => void>()
  const changeListeners = new Set<(change: RealtimeWorkspaceChange) => void>()
  const pendingChanges: RealtimeWorkspaceChange[] = []
  let requestHandler: RealtimeRequestHandler | undefined
  let currentStatus: RealtimeRoomStatus = "connecting"
  let destroyed = false
  let document: Y.Doc
  let provider: WebsocketProvider
  const emit = () => {
    for (const listener of updateListeners) listener()
  }
  const url = () => {
    const app = options.origin ? new URL(options.origin) : window.location
    const protocol = app.protocol === "https:" ? "wss:" : "ws:"
    return `${protocol}//${app.host}${resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}`, options.baseURL)}`
  }
  const room = documentId.split("/").map(encodeURIComponent).join("/")
  const localState: Record<string, unknown> = {}

  function connect() {
    document = new Y.Doc()
    provider = new WebsocketProvider(url(), room, document, { disableBc: true, params: { ...options.params, clientId: String(document.clientID) } })
    const current = provider
    keepRealtimeSocketAlive(current)
    current.messageHandlers[messageRealtimeControl] = (_encoder, decoder) => {
      // SAFETY: y-websocket passes the lib0 decoder positioned after the message type.
      const control = decodeRealtimeControlPayload(decoder as decoding.Decoder)
      if (!control) return
      if (control.type === "session") {
        current.params.epoch = control.epoch
        return
      }
      // The room re-seeded. Presence holds no document state, so join the new seed.
      current.destroy()
      document.destroy()
      if (!destroyed) connect()
    }
    current.messageHandlers[messageRealtimeRequest] = (_encoder, decoder) => {
      // SAFETY: y-websocket passes the lib0 decoder positioned after the message type.
      const frame = decodeRealtimeRequestFramePayload(decoder as decoding.Decoder)
      if (frame?.kind === "request") void answer(current, frame.id, frame.body)
    }
    // Send only this client's awareness: the server closes a connection that changes clients it does not own.
    current.awareness.off("update", current._awarenessUpdateHandler)
    current.awareness.on("update", ({ added, removed, updated }: { added: number[], removed: number[], updated: number[] }) => {
      const own = [...added, ...updated, ...removed].filter(client => client === current.doc.clientID)
      const socket = current.ws
      if (!own.length || !current.wsconnected || !socket || socket.readyState !== socket.OPEN) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(current.awareness, own))
      socket.send(encoding.toUint8Array(encoder))
    })
    const identity = options.identity ?? { id: `guest:${document.clientID}` }
    current.awareness.setLocalState({ ...localState, user: createRealtimeIdentity({ ...identity, id: identity.id || `guest:${document.clientID}` }) })
    current.awareness.on("change", emit)
    current.on("status", (event: { status: RealtimeRoomStatus }) => {
      currentStatus = event.status
      emit()
    })
  }
  connect()

  let changes: WebsocketProvider | undefined
  if (options.changes) {
    changes = new WebsocketProvider(url(), encodeURIComponent(workspaceRoomId), new Y.Doc(), {
      disableBc: true,
      params: { ...options.params, workspace: "events" },
    })
    changes.awareness.setLocalState(null)
    keepRealtimeSocketAlive(changes)
    changes.messageHandlers[messageWorkspaceChange] = (_encoder, decoder) => {
      // SAFETY: y-websocket passes the lib0 decoder positioned after the message type.
      const change = decodeWorkspaceChangePayload(decoder as decoding.Decoder)
      if (!change) return
      for (const listener of changeListeners) listener(change)
    }
    changes.on("status", (event: { status: RealtimeRoomStatus }) => {
      if (event.status === "connected") flush()
    })
  }

  async function answer(current: WebsocketProvider, id: string, body: unknown) {
    let frame: Uint8Array
    try {
      if (!requestHandler) throw new Error("This page does not answer requests.")
      frame = encodeRealtimeRequestFrame({ kind: "answer", id, ok: true, body: await requestHandler(body) })
      if (frame.byteLength > maxAnswerBytes) throw new Error(`The answer has ${frame.byteLength} bytes, over the 1 MiB limit.`)
    }
    catch (error) {
      frame = encodeRealtimeRequestFrame({ kind: "answer", id, ok: false, why: error instanceof Error ? error.message : String(error) })
    }
    const socket = current.ws
    if (current.wsconnected && socket && socket.readyState === socket.OPEN) socket.send(Uint8Array.from(frame))
  }

  function flush() {
    const socket = changes?.ws
    if (!changes?.wsconnected || !socket || socket.readyState !== socket.OPEN) return
    while (pendingChanges.length) socket.send(Uint8Array.from(encodeWorkspaceChange(pendingChanges.shift()!)))
  }

  return {
    get awareness() {
      return provider.awareness
    },
    get clientId() {
      return document.clientID
    },
    people: () => getRealtimePeople(provider.awareness.getStates()),
    states: () => {
      const states = new Map(provider.awareness.getStates())
      states.delete(document.clientID)
      return states
    },
    status: () => currentStatus,
    setLocal(field, value) {
      if (value === null) delete localState[field]
      else localState[field] = value
      provider.awareness.setLocalStateField(field, value)
    },
    notify(change) {
      if (!changes) return
      pendingChanges.push(change)
      flush()
    },
    onUpdate(listener) {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    onChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    onRequest(handler) {
      requestHandler = handler
      return () => {
        if (requestHandler === handler) requestHandler = undefined
      }
    },
    destroy() {
      destroyed = true
      provider.destroy()
      document.destroy()
      changes?.destroy()
      changes?.doc.destroy()
      updateListeners.clear()
      changeListeners.clear()
      requestHandler = undefined
    },
  }
}
