import Collaboration from "@tiptap/extension-collaboration"
import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import { useUserSession } from "@vite-hub/auth/vue"
import * as decoding from "lib0/decoding"
import { computed, markRaw, onScopeDispose, ref, shallowRef, toValue, watch } from "vue"
import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

import type { WorkspaceSnapshot } from "@vite-hub/workspace"
import type { MaybeRefOrGetter } from "vue"
import type { RealtimeIdentity } from "./presence.ts"
import type { RealtimePerson, RealtimeWorkspaceChange } from "./types.ts"
import { resolveRealtimeApplicationPath } from "./application-path.ts"
import { createRealtimeIdentity, getRealtimePeople } from "./presence.ts"
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, messageWorkspaceChange, workspaceRoomId } from "./protocol.ts"

export type RealtimeStatus = "connected" | "connecting" | "disconnected"

export function useRealtimeTiptap(definition: string, documentId: MaybeRefOrGetter<string | undefined>) {
  const { user } = useUserSession()
  const document = shallowRef<Y.Doc>()
  const provider = shallowRef<WebsocketProvider>()
  const workspaceProvider = shallowRef<WebsocketProvider>()
  const workspaceChange = shallowRef<RealtimeWorkspaceChange>()
  const people = shallowRef<RealtimePerson[]>([])
  const status = ref<RealtimeStatus>("disconnected")
  const synced = ref(false)
  const pendingWorkspaceChanges: RealtimeWorkspaceChange[] = []

  function destroyDocument() {
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
    const current = workspaceProvider.value
    const socket = current?.ws
    if (!current?.wsconnected || !socket || socket.readyState !== socket.OPEN) return
    for (const change of pendingWorkspaceChanges.splice(0)) socket.send(Uint8Array.from(encodeWorkspaceChange(change)))
  }

  function notifyWorkspaceChange(change: RealtimeWorkspaceChange) {
    pendingWorkspaceChanges.push(change)
    flushWorkspaceChanges()
  }

  function destroy() {
    destroyDocument()
    workspaceProvider.value?.destroy()
    workspaceProvider.value?.doc.destroy()
    workspaceProvider.value = undefined
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
    nextWorkspaceProvider.connect()
  }

  async function checkpoint(): Promise<WorkspaceSnapshot> {
    const id = toValue(documentId)
    if (!id) throw new Error("A realtime document is required before creating a checkpoint.")
    const room = id.split("/").map(encodeURIComponent).join("/")
    for (let attempt = 0; ; attempt++) {
      const current = document.value
      if (!current) throw new Error("The realtime document is not connected.")
      const response = await fetch(resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}/${room}?history=checkpoint`), {
        body: Uint8Array.from(Y.encodeStateAsUpdate(current)).buffer,
        method: "POST",
      })
      if (response.ok) return await response.json() as WorkspaceSnapshot
      const data = await response.json().catch(() => undefined) as { data?: { code?: string }, message?: string, statusMessage?: string } | undefined
      if (response.status === 409 && data?.data?.code === "REALTIME_SYNC_PENDING" && attempt < 20) {
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      throw Object.assign(new Error(data?.statusMessage || data?.message || "Could not create the realtime checkpoint."), {
        data,
        statusCode: response.status,
      })
    }
  }

  watch(() => toValue(documentId), (id) => {
    destroyDocument()
    if (!id || typeof window === "undefined") return
    const nextDocument = markRaw(new Y.Doc())
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const server = `${protocol}//${window.location.host}${resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}`)}`
    const room = id.split("/").map(encodeURIComponent).join("/")
    const nextProvider = new WebsocketProvider(server, room, nextDocument, { disableBc: true })
    nextProvider.awareness.setLocalStateField("user", currentPerson(nextDocument.clientID))
    nextProvider.awareness.on("change", () => updatePeople(nextProvider))
    updatePeople(nextProvider)
    nextProvider.on("status", (event: { status: RealtimeStatus }) => status.value = event.status)
    nextProvider.on("sync", (value: boolean) => synced.value = value)
    document.value = nextDocument
    provider.value = nextProvider
    status.value = "connecting"
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
          Image,
          TableKit,
          markRaw(Collaboration.configure({ fragment: markRaw(document.value.getXmlFragment("default")) })),
        ]
      : []),
    people,
    provider,
    status,
    synced,
    history: { checkpoint },
    workspace: {
      change: workspaceChange,
      notify: notifyWorkspaceChange,
    },
    destroy,
  }
}
