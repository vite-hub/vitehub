import Collaboration from "@tiptap/extension-collaboration"
import { useUserSession } from "@vite-hub/auth/vue"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import { computed, markRaw, onScopeDispose, ref, shallowRef, toValue, watch } from "vue"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

import type { AnyExtension } from "@tiptap/core"
import type { MaybeRefOrGetter, Ref } from "vue"
import type { RealtimeIdentity } from "./presence.ts"
import type { RealtimeCheckpoint, RealtimeDocumentStatus, RealtimeEditor, RealtimePerson, RealtimeReadOnlyReason, RealtimeResetReason, RealtimeSaved, RealtimeUser, RealtimeWorkspaceChange } from "./types.ts"
import { resolveRealtimeApplicationPath } from "./application-path.ts"
import { RealtimeCaret } from "./caret.ts"
import { createRealtimeEditorExtensions } from "./editor.ts"
import { readRealtimeStatus, realtimeDocumentLayout } from "./layout.ts"
import { createRealtimeIdentity, getRealtimePeople } from "./presence.ts"
import {
  decodeRealtimeControlPayload,
  decodeWorkspaceChangePayload,
  encodeWorkspaceChange,
  isRetryableRealtimeRequestCode,
  messageAwareness,
  messageRealtimeControl,
  messageWorkspaceChange,
  workspaceRoomId,
} from "./protocol.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

export { RealtimeCaret } from "./caret.ts"
export type { RealtimeCaretOptions, RealtimeCaretUser } from "./caret.ts"

export type RealtimeStatus = "connected" | "connecting" | "disconnected"

export interface RealtimeResetEvent {
  /** Room seed the client reconnects to. */
  epoch: string
  /** The document this client held before the reset, including edits the room did not save. Destroyed after listeners return. */
  previous: Y.Doc
  /** `source-changed`: the stored document changed outside the room. `stale`: the room was re-seeded while this client was away. */
  reason: RealtimeResetReason
}

export interface UseRealtimeTiptapOptions {
  /** Editor schema shared with the definition's `editor`. Defaults to the built-in Markdown kit. */
  editor?: Pick<RealtimeEditor, "extensions">
  enabled?: MaybeRefOrGetter<boolean>
  /** Presence identity. Defaults to the ViteHub Auth session; pass `null` for an anonymous guest. */
  identity?: MaybeRefOrGetter<RealtimeUser | null | undefined>
  /**
   * Other people's carets and selections, in their presence color. Defaults to `true`. They use TipTap's
   * CollaborationCaret classes (`collaboration-carets__caret`, `collaboration-carets__label`, `ProseMirror-yjs-selection`).
   */
  carets?: boolean
  onReset?: (event: RealtimeResetEvent) => void
}

const workspaceChangeFlushIntervalMs = 11

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isRealtimeSaved(value: unknown): value is RealtimeSaved {
  if (!isRecord(value) || !isRecord(value.document) || !isString(value.document.body)) return false
  if (value.document.fields !== undefined && !isRecord(value.document.fields)) return false
  if (value.digest !== null && !isString(value.digest)) return false
  if (value.savedAt !== null && !isString(value.savedAt)) return false
  if (value.error !== null && !isString(value.error)) return false
  return Array.isArray(value.issues) && (value.savedBy === null || isRecord(value.savedBy))
}

function isRealtimeCheckpoint(value: unknown): value is RealtimeCheckpoint {
  if (!isRealtimeSaved(value) || !isString(value.digest)) return false
  const snapshot = "snapshot" in value ? value.snapshot : undefined
  if (!isRecord(snapshot)) return false
  if (typeof snapshot.id !== "string" || typeof snapshot.createdAt !== "string") return false
  if (snapshot.name !== undefined && !isString(snapshot.name)) return false
  if (!isRecord(snapshot.entries)) return false
  return Object.values(snapshot.entries).every((entry) => {
    if (!isRecord(entry) || (entry.type !== "file" && entry.type !== "directory")) return false
    if (entry.digest !== undefined && !isString(entry.digest)) return false
    if (entry.metadata !== undefined && !isRecord(entry.metadata)) return false
    if (entry.size !== undefined) {
      if (typeof entry.size !== "number" || !Number.isFinite(entry.size)) return false
    }
    return true
  })
}

function isRefreshResult(value: unknown): value is { digest: string | null, reseeded: boolean } {
  return isRecord(value) && (value.digest === null || isString(value.digest)) && typeof value.reseeded === "boolean"
}

export function useRealtimeTiptap(definition: string, documentId: MaybeRefOrGetter<string | undefined>, options: UseRealtimeTiptapOptions = {}) {
  // SAFETY: The ViteHub Auth session user is a Better Auth user record; presence reads only id, name, email, and image.
  const sessionUser: Ref<Record<string, unknown> | null | undefined> | undefined = options.identity === undefined
    ? useUserSession().user as Ref<Record<string, unknown> | null | undefined>
    : undefined
  const identity = () => options.identity === undefined ? sessionUser?.value : toValue(options.identity)
  const createExtensions = () => options.editor ? options.editor.extensions() : createRealtimeEditorExtensions({ collaborative: true })
  const document = shallowRef<Y.Doc>()
  const provider = shallowRef<WebsocketProvider>()
  const workspaceProvider = shallowRef<WebsocketProvider>()
  const workspaceChange = shallowRef<RealtimeWorkspaceChange>()
  const people = shallowRef<RealtimePerson[]>([])
  const saveStatus = shallowRef<RealtimeDocumentStatus>()
  const status = ref<RealtimeStatus>("disconnected")
  const synced = ref(false)
  const readOnlyReason = ref<RealtimeReadOnlyReason | null>(null)
  const checkpointRequests = ref(0)
  const saveRequests = ref(0)
  const pendingWorkspaceChanges: RealtimeWorkspaceChange[] = []
  const requestControllers = new Set<AbortController>()
  const refreshControllers = new Set<AbortController>()
  const resetListeners = new Set<(event: RealtimeResetEvent) => void>()
  if (options.onReset) resetListeners.add(options.onReset)
  let connectedDocumentId: string | undefined
  let workspaceChangeTimer: ReturnType<typeof setTimeout> | undefined
  const enabled = () => options.enabled === undefined || toValue(options.enabled)

  function destroyDocument(keepDocument = false, preserveRefresh = false) {
    for (const controller of requestControllers) {
      if (!preserveRefresh || !refreshControllers.has(controller)) controller.abort()
    }
    if (preserveRefresh) {
      for (const controller of requestControllers) {
        if (!refreshControllers.has(controller)) requestControllers.delete(controller)
      }
    }
    else {
      requestControllers.clear()
      refreshControllers.clear()
    }
    connectedDocumentId = undefined
    provider.value?.destroy()
    if (!keepDocument) document.value?.destroy()
    provider.value = undefined
    document.value = undefined
    people.value = []
    saveStatus.value = undefined
    status.value = "disconnected"
    synced.value = false
    readOnlyReason.value = null
  }

  function currentPerson(clientId: number): RealtimeIdentity {
    const value = identity()
    const id = isString(value?.id) && value.id ? value.id : `guest:${clientId}`
    return createRealtimeIdentity({ ...value, id })
  }

  function updatePeople(current: WebsocketProvider) {
    people.value = getRealtimePeople(current.awareness.getStates())
  }

  function flushWorkspaceChanges() {
    if (workspaceChangeTimer) return
    const current = workspaceProvider.value
    const socket = current?.ws
    if (!current?.wsconnected || !socket || socket.readyState !== socket.OPEN) return
    const change = pendingWorkspaceChanges[0]
    if (!change) return
    socket.send(Uint8Array.from(encodeWorkspaceChange(change)))
    pendingWorkspaceChanges.shift()
    if (pendingWorkspaceChanges.length) {
      workspaceChangeTimer = setTimeout(() => {
        workspaceChangeTimer = undefined
        flushWorkspaceChanges()
      }, workspaceChangeFlushIntervalMs)
    }
  }

  function notifyWorkspaceChange(change: RealtimeWorkspaceChange) {
    if (!enabled()) return
    pendingWorkspaceChanges.push(change)
    flushWorkspaceChanges()
  }

  function destroy() {
    destroyDocument()
    workspaceProvider.value?.destroy()
    workspaceProvider.value?.doc.destroy()
    workspaceProvider.value = undefined
    if (workspaceChangeTimer) clearTimeout(workspaceChangeTimer)
    workspaceChangeTimer = undefined
    pendingWorkspaceChanges.length = 0
  }

  function serverURL() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${protocol}//${window.location.host}${resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}`)}`
  }

  if (typeof window !== "undefined") {
    const workspaceDocument = markRaw(new Y.Doc())
    const nextWorkspaceProvider = new WebsocketProvider(serverURL(), encodeURIComponent(workspaceRoomId), workspaceDocument, {
      connect: false,
      disableBc: true,
      params: { workspace: "events" },
    })
    nextWorkspaceProvider.awareness.setLocalState(null)
    nextWorkspaceProvider.messageHandlers[messageWorkspaceChange] = (_encoder, decoder) => {
      const change = decodeWorkspaceChangePayload(decoder as decoding.Decoder)
      if (change) workspaceChange.value = change
    }
    nextWorkspaceProvider.on("status", (event: { status: RealtimeStatus }) => {
      if (event.status === "connected") flushWorkspaceChanges()
    })
    workspaceProvider.value = nextWorkspaceProvider
  }

  function connect(id: string) {
    const nextDocument = markRaw(new Y.Doc())
    const room = id.split("/").map(encodeURIComponent).join("/")
    const nextProvider = new WebsocketProvider(serverURL(), room, nextDocument, { disableBc: true, params: {} })
    nextProvider.messageHandlers[messageRealtimeControl] = (_encoder, decoder) => {
      if (provider.value !== nextProvider) return
      // SAFETY: y-websocket passes the lib0 decoder positioned after the message type.
      const control = decodeRealtimeControlPayload(decoder as decoding.Decoder)
      if (!control) return
      if (control.type === "session") {
        // Reconnects present this seed; the server resets the client if the room was re-seeded meanwhile.
        nextProvider.params.epoch = control.epoch
        readOnlyReason.value = control.access === "read" ? control.reason ?? "access" : null
        return
      }
      reset(id, control.reason, control.epoch)
    }
    // y-websocket sends every awareness change it sees, other clients' too. The server lets each connection change only
    // the clients it owns and closes it otherwise, so send this client's own state only.
    nextProvider.awareness.off("update", nextProvider._awarenessUpdateHandler)
    nextProvider.awareness.on("update", ({ added, removed, updated }: { added: number[], removed: number[], updated: number[] }) => {
      const own = [...added, ...updated, ...removed].filter(client => client === nextDocument.clientID)
      const socket = nextProvider.ws
      if (!own.length || !nextProvider.wsconnected || !socket || socket.readyState !== socket.OPEN) return
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(nextProvider.awareness, own))
      socket.send(encoding.toUint8Array(encoder))
    })
    nextProvider.awareness.setLocalStateField("user", currentPerson(nextDocument.clientID))
    nextProvider.awareness.on("change", () => {
      if (provider.value === nextProvider) updatePeople(nextProvider)
    })
    updatePeople(nextProvider)
    const statusMap = nextDocument.getMap(realtimeDocumentLayout.status)
    statusMap.observe(() => {
      if (document.value === nextDocument) saveStatus.value = readRealtimeStatus(nextDocument)
    })
    nextProvider.on("status", (event: { status: RealtimeStatus }) => {
      if (provider.value === nextProvider) status.value = event.status
    })
    nextProvider.on("sync", (value: boolean) => {
      if (provider.value !== nextProvider) return
      synced.value = value
      if (value) saveStatus.value = readRealtimeStatus(nextDocument)
    })
    connectedDocumentId = id
    document.value = nextDocument
    provider.value = nextProvider
    status.value = "connecting"
  }

  function reset(id: string, reason: RealtimeResetReason, epoch: string) {
    const previous = document.value
    destroyDocument(true, true)
    if (previous) {
      try {
        for (const listener of resetListeners) listener({ epoch, previous, reason })
      }
      finally {
        previous.destroy()
      }
    }
    if (enabled() && toValue(documentId) === id) connect(id)
  }

  function onReset(listener: (event: RealtimeResetEvent) => void): () => void {
    resetListeners.add(listener)
    return () => resetListeners.delete(listener)
  }

  function disconnected(): never {
    throw realtimeErrorDiagnostics.REALTIME_R0011({ message: "The realtime document is no longer connected to this request." })
  }

  async function request(action: "checkpoint" | "refresh" | "save"): Promise<unknown> {
    const controller = new AbortController()
    requestControllers.add(controller)
    if (action === "refresh") refreshControllers.add(controller)
    try {
      const id = toValue(documentId)
      if (!id) throw realtimeErrorDiagnostics.REALTIME_R0010({ message: "A realtime document is required for this request." })
      const room = id.split("/").map(encodeURIComponent).join("/")
      const current = document.value
      const query = action === "checkpoint" ? "history=checkpoint" : `document=${action}`
      const stillCurrent = () => !controller.signal.aborted && !!current && connectedDocumentId === id && document.value === current && toValue(documentId) === id && enabled()
      for (let attempt = 0; ; attempt++) {
        // A refresh may intentionally re-seed the room and replace `document`
        // before its HTTP response arrives. The successful response remains
        // valid even though that reset makes the old document non-current.
        if (action !== "refresh" && !stillCurrent()) disconnected()
        let response: Response
        try {
          response = await fetch(resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}/${room}?${query}`), {
            body: action === "refresh" ? undefined : Uint8Array.from(Y.encodeStateAsUpdate(current!)).buffer,
            method: "POST",
            signal: controller.signal,
          })
        }
        catch (error) {
          if (controller.signal.aborted) disconnected()
          throw error
        }
        let data: unknown
        try {
          data = await response.json()
        }
        catch {
          if (controller.signal.aborted) disconnected()
        }
        if (action !== "refresh" && !stillCurrent()) disconnected()
        if (response.ok) return data
        const errorData = isRecord(data) ? data : undefined
        const nestedData = isRecord(errorData?.data) ? errorData.data : undefined
        const message = isString(errorData?.statusMessage) && errorData.statusMessage
          ? errorData.statusMessage
          : isString(errorData?.message) ? errorData.message : undefined
        if (response.status === 409 && isRetryableRealtimeRequestCode(isString(nestedData?.code) ? nestedData.code : undefined) && attempt < 20) {
          await new Promise(resolve => setTimeout(resolve, 50))
          continue
        }
        throw Object.assign(realtimeErrorDiagnostics.REALTIME_R0012({ message: message || "The realtime request failed." }), {
          data,
          statusCode: response.status,
        })
      }
    }
    finally {
      requestControllers.delete(controller)
      refreshControllers.delete(controller)
    }
  }

  function invalidResponse(data: unknown): never {
    throw Object.assign(realtimeErrorDiagnostics.REALTIME_R0012({ message: "The realtime response was invalid." }), { data, statusCode: 200 })
  }

  /** Saves the room through its document adapter now, including every edit this client has sent. */
  async function save(): Promise<RealtimeSaved> {
    if (!enabled()) throw realtimeErrorDiagnostics.REALTIME_R0009({ message: "Realtime is disabled." })
    saveRequests.value++
    try {
      const data = await request("save")
      return isRealtimeSaved(data) ? data : invalidResponse(data)
    }
    finally {
      saveRequests.value--
    }
  }

  /** Saves the room and records a durable history entry through the document adapter. */
  async function checkpoint(): Promise<RealtimeCheckpoint> {
    if (!enabled()) throw realtimeErrorDiagnostics.REALTIME_R0009({ message: "Realtime is disabled." })
    checkpointRequests.value++
    try {
      const data = await request("checkpoint")
      return isRealtimeCheckpoint(data) ? data : invalidResponse(data)
    }
    finally {
      checkpointRequests.value--
    }
  }

  /** Asks the room to compare its seed with the stored document. A changed source resets every client. */
  async function refresh(): Promise<{ digest: string | null, reseeded: boolean }> {
    if (!enabled()) throw realtimeErrorDiagnostics.REALTIME_R0009({ message: "Realtime is disabled." })
    const data = await request("refresh")
    return isRefreshResult(data) ? data : invalidResponse(data)
  }

  watch([() => toValue(documentId), enabled], ([id, active]) => {
    destroyDocument()
    if (!active || !id || typeof window === "undefined") return
    connect(id)
  }, { immediate: true })

  watch(enabled, (active) => {
    const current = workspaceProvider.value
    if (!current) return
    if (active) current.connect()
    else {
      current.disconnect()
      pendingWorkspaceChanges.length = 0
    }
  }, { immediate: true })

  watch(identity, () => {
    const current = provider.value
    if (!current) return
    current.awareness.setLocalStateField("user", currentPerson(current.doc.clientID))
    updatePeople(current)
  })

  onScopeDispose(destroy)

  return {
    document,
    extensions: computed<AnyExtension[]>(() => document.value
      && provider.value
      ? [
          ...createExtensions(),
          markRaw(Collaboration.configure({ fragment: markRaw(document.value.getXmlFragment(realtimeDocumentLayout.body)) })),
          ...(options.carets === false ? [] : [markRaw(RealtimeCaret.configure({ awareness: markRaw(provider.value.awareness) }))]),
        ]
      : []),
    fields: computed(() => document.value?.getMap<unknown>(realtimeDocumentLayout.fields)),
    people,
    provider,
    /** The server rejects edits from this connection. `readOnlyReason` tells why; `saveStatus` holds the details. */
    readOnly: computed(() => readOnlyReason.value !== null),
    readOnlyReason,
    refresh,
    onReset,
    save,
    saveStatus,
    saving: computed(() => saveRequests.value > 0),
    status,
    synced,
    history: { checkpoint, pending: computed(() => checkpointRequests.value > 0) },
    workspace: {
      change: workspaceChange,
      notify: notifyWorkspaceChange,
    },
    destroy,
  }
}
