import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"
import Image from "@tiptap/extension-image"
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
import { getRealtimePeople } from "./presence.ts"
import { decodeWorkspaceChangePayload, encodeWorkspaceChange, messageWorkspaceChange, workspaceRoomId } from "./protocol.ts"

export type RealtimeStatus = "connected" | "connecting" | "disconnected"

const personColors = ["#E11D48", "#D97706", "#059669", "#0891B2", "#2563EB", "#7C3AED", "#C026D3"]

function personColor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = Math.imul(31, hash) + id.charCodeAt(index) | 0
  return personColors[Math.abs(hash) % personColors.length]!
}

function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color = typeof user.color === "string" && /^#[\da-f]{6}$/i.test(user.color) ? user.color : "#64748B"
  const name = typeof user.name === "string" ? user.name : "Collaborator"
  const caret = document.createElement("span")
  Object.assign(caret.style, {
    borderLeft: `2px solid ${color}`,
    marginLeft: "-1px",
    marginRight: "-1px",
    pointerEvents: "none",
    position: "relative",
    wordBreak: "normal",
  })
  caret.animate([{ borderColor: color }, { borderColor: "transparent" }, { borderColor: color }], {
    duration: 1000,
    iterations: Infinity,
  })
  const label = document.createElement("span")
  label.textContent = name
  Object.assign(label.style, {
    backgroundColor: color,
    borderRadius: "3px 3px 3px 0",
    color: "white",
    fontSize: "12px",
    fontWeight: "600",
    left: "-2px",
    lineHeight: "1",
    padding: "4px 6px",
    position: "absolute",
    top: "-24px",
    userSelect: "none",
    whiteSpace: "nowrap",
  })
  label.animate([{ opacity: 1 }, { opacity: 1, offset: 0.65 }, { opacity: 0 }], { duration: 2000, fill: "forwards" })
  caret.append(label)
  return caret
}

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
    return {
      color: personColor(id),
      id,
      ...(value?.image ? { image: value.image } : {}),
      name: value?.name || value?.email || "Anonymous",
    }
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
    const response = await fetch(resolveRealtimeApplicationPath(`/api/_vitehub/realtime/${encodeURIComponent(definition)}/${room}?history=checkpoint`), {
      method: "POST",
    })
    if (!response.ok) {
      const data = await response.json().catch(() => undefined) as { message?: string, statusMessage?: string } | undefined
      throw Object.assign(new Error(data?.statusMessage || data?.message || "Could not create the realtime checkpoint."), {
        data,
        statusCode: response.status,
      })
    }
    return await response.json() as WorkspaceSnapshot
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
          markRaw(Collaboration.configure({ fragment: markRaw(document.value.getXmlFragment("default")) })),
          markRaw(CollaborationCaret.configure({
            provider: markRaw(provider.value),
            render: renderCaret,
            user: currentPerson(document.value.clientID),
          })),
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
