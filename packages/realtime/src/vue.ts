import Collaboration from "@tiptap/extension-collaboration"
import { useUserSession } from "@vite-hub/auth/vue"
import * as decoding from "lib0/decoding"
import { computed, markRaw, onScopeDispose, ref, shallowRef, toValue, watch } from "vue"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

import type { MaybeRefOrGetter } from "vue"
import type { RealtimeIdentity } from "./presence.ts"
import type { RealtimeCheckpoint, RealtimePerson, RealtimeWorkspaceChange } from "./types.ts"
import { resolveRealtimeApplicationPath } from "./application-path.ts"
import { createRealtimeEditorExtensions } from "./editor-extensions.ts"
import { createRealtimeIdentity, getRealtimePeople } from "./presence.ts"
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, isRetryableRealtimeCheckpointCode, messageWorkspaceChange, workspaceRoomId } from "./protocol.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

export type RealtimeStatus = "connected" | "connecting" | "disconnected"

const workspaceChangeFlushIntervalMs = 11

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Check the untrusted checkpoint JSON representation before reading fields.
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Error fields cross an untyped provider boundary.
  return typeof value === "string"
}

function isRealtimeCheckpoint(value: unknown): value is RealtimeCheckpoint {
  if (!isRecord(value) || !isRecord(value.snapshot)) return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Check the untrusted checkpoint content before returning it.
  if (typeof value.content !== "string") return false
  const snapshot = value.snapshot
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Snapshot identifiers and timestamps cross the JSON boundary as unknown values.
  if (typeof snapshot.id !== "string" || typeof snapshot.createdAt !== "string") return false
  if (snapshot.name !== undefined) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Optional snapshot names are untrusted JSON values.
    if (typeof snapshot.name !== "string") return false
  }
  if (!isRecord(snapshot.entries)) return false
  return Object.values(snapshot.entries).every((entry) => {
    if (!isRecord(entry) || (entry.type !== "file" && entry.type !== "directory")) return false
    if (entry.digest !== undefined) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Optional entry digests are untrusted JSON values.
      if (typeof entry.digest !== "string") return false
    }
    if (entry.metadata !== undefined && !isRecord(entry.metadata)) return false
    if (entry.size !== undefined) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Optional entry sizes are untrusted JSON values.
      if (typeof entry.size !== "number" || !Number.isFinite(entry.size)) return false
    }
    return true
  })
}

export interface UseRealtimeTiptapOptions {
  enabled?: MaybeRefOrGetter<boolean>
}

export function useRealtimeTiptap(definition: string, documentId: MaybeRefOrGetter<string | undefined>, options: UseRealtimeTiptapOptions = {}) {
  const { user } = useUserSession()
  const document = shallowRef<Y.Doc>()
  const provider = shallowRef<WebsocketProvider>()
  const workspaceProvider = shallowRef<WebsocketProvider>()
  const workspaceChange = shallowRef<RealtimeWorkspaceChange>()
  const people = shallowRef<RealtimePerson[]>([])
  const status = ref<RealtimeStatus>("disconnected")
  const synced = ref(false)
  const checkpointRequests = ref(0)
  const pendingWorkspaceChanges: RealtimeWorkspaceChange[] = []
  let connectedDocumentId: string | undefined
  let workspaceChangeTimer: ReturnType<typeof setTimeout> | undefined
  const enabled = () => options.enabled === undefined || toValue(options.enabled)

  function destroyDocument() {
    connectedDocumentId = undefined
    provider.value?.destroy()
    document.value?.destroy()
    provider.value = undefined
    document.value = undefined
    people.value = []
    status.value = "disconnected"
    synced.value = false
  }

  function currentPerson(clientId: number): RealtimeIdentity {
    const value = user.value
    const id = value?.id || `guest:${clientId}`
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

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const server = `${protocol}//${window.location.host}${resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}`)}`
    const workspaceDocument = markRaw(new Y.Doc())
    const nextWorkspaceProvider = new WebsocketProvider(server, encodeURIComponent(workspaceRoomId), workspaceDocument, {
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

  async function checkpoint(): Promise<RealtimeCheckpoint> {
    if (!enabled()) throw realtimeErrorDiagnostics.REALTIME_R0009({ message: "Realtime is disabled." })
    checkpointRequests.value++
    try {
      const id = toValue(documentId)
      if (!id) throw realtimeErrorDiagnostics.REALTIME_R0010({ message: "A realtime document is required before creating a checkpoint." })
      const room = id.split("/").map(encodeURIComponent).join("/")
      const current = document.value
      for (let attempt = 0; ; attempt++) {
        if (!current || connectedDocumentId !== id || document.value !== current || toValue(documentId) !== id || !enabled()) {
          throw realtimeErrorDiagnostics.REALTIME_R0011({ message: "The realtime document is no longer connected to this checkpoint." })
        }
        const response = await fetch(resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}/${room}?history=checkpoint`), {
          body: Uint8Array.from(Y.encodeStateAsUpdate(current)).buffer,
          method: "POST",
        })
        if (response.ok) {
          const result: unknown = await response.json().catch(() => undefined)
          if (isRealtimeCheckpoint(result)) return result
          throw Object.assign(realtimeErrorDiagnostics.REALTIME_R0012({ message: "The realtime checkpoint response was invalid." }), {
            data: result,
            statusCode: response.status,
          })
        }
        const data: unknown = await response.json().catch(() => undefined)
        const errorData = isRecord(data) ? data : undefined
        const nestedData = isRecord(errorData?.data) ? errorData.data : undefined
        const message = isString(errorData?.statusMessage) && errorData.statusMessage
          ? errorData.statusMessage
          : isString(errorData?.message) ? errorData.message : undefined
        if (response.status === 409 && isRetryableRealtimeCheckpointCode(isString(nestedData?.code) ? nestedData.code : undefined) && attempt < 20) {
          await new Promise(resolve => setTimeout(resolve, 50))
          continue
        }
        throw Object.assign(realtimeErrorDiagnostics.REALTIME_R0012({ message: message || "Could not create the realtime checkpoint." }), {
          data,
          statusCode: response.status,
        })
      }
    }
    finally {
      checkpointRequests.value--
    }
  }

  watch([() => toValue(documentId), enabled], ([id, active]) => {
    destroyDocument()
    if (!active || !id || typeof window === "undefined") return
    const nextDocument = markRaw(new Y.Doc())
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const server = `${protocol}//${window.location.host}${resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}`)}`
    const room = id.split("/").map(encodeURIComponent).join("/")
    const nextProvider = new WebsocketProvider(server, room, nextDocument, { disableBc: true })
    nextProvider.awareness.setLocalStateField("user", currentPerson(nextDocument.clientID))
    nextProvider.awareness.on("change", () => {
      if (provider.value === nextProvider) updatePeople(nextProvider)
    })
    updatePeople(nextProvider)
    nextProvider.on("status", (event: { status: RealtimeStatus }) => {
      if (provider.value === nextProvider) status.value = event.status
    })
    nextProvider.on("sync", (value: boolean) => {
      if (provider.value === nextProvider) synced.value = value
    })
    connectedDocumentId = id
    document.value = nextDocument
    provider.value = nextProvider
    status.value = "connecting"
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

  watch(user, () => {
    const current = provider.value
    if (!current) return
    current.awareness.setLocalStateField("user", currentPerson(current.doc.clientID))
    updatePeople(current)
  })

  onScopeDispose(destroy)

  return {
    document,
    extensions: computed(() => document.value
      && provider.value
        ? [
          ...createRealtimeEditorExtensions(),
          markRaw(Collaboration.configure({ fragment: markRaw(document.value.getXmlFragment("default")) })),
        ]
      : []),
    people,
    provider,
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
