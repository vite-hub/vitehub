import { contentRealtimeEditor } from "@vite-hub/content/editor"
import { readRealtimeYDoc, useRealtimeTiptap } from "@vite-hub/realtime/vue"
import { computed, onBeforeUnmount, shallowRef, watch } from "vue"

import type { RealtimeIssue, RealtimeUser } from "@vite-hub/realtime"
import type { RealtimeResetEvent } from "@vite-hub/realtime/vue"
import type { ComputedRef, Ref, ShallowRef } from "vue"
import type { ConsoleDocumentComponent } from "../definitions"
import type { ConsoleDocumentSessionUser } from "./documents"

/** One other person in a live room, with the property they are editing, if any. */
export interface ConsoleLivePerson {
  clientId: number
  color: string
  id: string
  image?: string
  name: string
  /** The top-level field whose property row has focus, such as `title`. */
  focus?: string
}

/** What a reset hands back: the document before it, in Markdown, when this tab had edits the room did not save. */
export interface ConsoleLiveReset {
  reason: RealtimeResetEvent["reason"]
  /** The body and fields this tab held before the reset, when it had unsaved edits. */
  unsaved?: { body: string, fields: Record<string, unknown> }
}

/** The collection components as Content declares them, keyed by tag, for the shared codec. */
function componentRecord(components: readonly ConsoleDocumentComponent[] | undefined) {
  return Object.fromEntries((components ?? []).map(component => [component.name, { kind: component.kind, props: component.props }]))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && Object(value) === value) {
    const record = Object(value) as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/** Whether a Y.Map value read from the room is a JSON field value. */
function fieldValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

export interface ConsoleLiveDocument {
  /** The room document. A reset replaces it, so the body editor mounts again for the new one. */
  document: ReturnType<typeof useRealtimeTiptap>["document"]
  /** The y-websocket provider of the room, for carets. */
  provider: ReturnType<typeof useRealtimeTiptap>["provider"]
  /** The room fields as plain JSON, once the room synced. */
  fields: ShallowRef<Record<string, unknown> | undefined>
  /** Writes changed fields to the room: one entry per field, so two people on different fields never collide. */
  writeFields: (next: Record<string, unknown>) => void
  /** Other people in the room, each once, with the field they focus. */
  others: ComputedRef<ConsoleLivePerson[]>
  /** Marks a field as focused by this tab, or none. */
  focus: (field: string | undefined) => void
  /** The room synced and the editor may mount. */
  ready: ComputedRef<boolean>
  status: Ref<"connected" | "connecting" | "disconnected">
  /** `access` without write access, `document` when the codec cannot keep the body. */
  readOnlyReason: Ref<"access" | "document" | null>
  /** Server-written save state: digest, issues, savedAt, savedBy, and the last error. */
  saveStatus: ReturnType<typeof useRealtimeTiptap>["saveStatus"]
  /** Field issues of the last room save, and the codec issue of a read-only body. */
  issues: ComputedRef<RealtimeIssue[]>
  /** Saves the room now, such as for ⌘S or before Publish. Resolves the saved draft digest. */
  save: () => Promise<string | null>
  /** The identity this tab shows in the room. */
  identity: ComputedRef<{ color: string, id: string, name: string } | undefined>
}

/**
 * Live co-editing of one Content document through its Realtime room. It connects with the Console user as identity,
 * mirrors the room fields as plain JSON, tracks which field each person focuses, and reports what a reset dropped.
 */
export function useConsoleLiveDocument(options: {
  definition: string
  /** The room `<collection>/<id>`, or undefined to stay disconnected. */
  room: () => string | undefined
  components: () => readonly ConsoleDocumentComponent[] | undefined
  user: () => ConsoleDocumentSessionUser | null | undefined
  onReset: (reset: ConsoleLiveReset) => void
}): ConsoleLiveDocument {
  const editor = contentRealtimeEditor({ components: componentRecord(options.components()) })
  let unsavedLocal = false
  const realtime = useRealtimeTiptap(options.definition, options.room, {
    editor,
    enabled: () => options.room() !== undefined,
    identity: () => {
      const user = options.user()
      if (!user) return null
      const identity: RealtimeUser = { id: user.id, name: user.name }
      if (user.image) identity.image = user.image
      return identity
    },
    onReset: (event) => {
      const hadUnsaved = unsavedLocal
      unsavedLocal = false
      if (!hadUnsaved) {
        options.onReset({ reason: event.reason })
        return
      }
      // `previous` is destroyed after listeners return. The body is read before the codec's first await, the fields now.
      const fields = event.previous.getMap("fields").toJSON()
      void readRealtimeYDoc(editor, event.previous).then(
        unsaved => options.onReset({ reason: event.reason, unsaved: { body: unsaved.body, fields } }),
        () => options.onReset({ reason: event.reason }),
      )
    },
  })

  const fields = shallowRef<Record<string, unknown>>()
  const states = shallowRef<Map<number, Record<string, unknown>>>(new Map())

  watch([realtime.fields, realtime.synced], ([map, synced], _previous, onCleanup) => {
    if (!map || !synced) {
      fields.value = undefined
      return
    }
    const sync = () => {
      fields.value = fieldValue(map.toJSON()) as Record<string, unknown>
    }
    map.observe(sync)
    sync()
    onCleanup(() => map.unobserve(sync))
  }, { immediate: true })

  // Local edits since the last room save, so a reset can offer what it dropped.
  watch(realtime.document, (document, _previous, onCleanup) => {
    if (!document) return
    const onUpdate = (_update: Uint8Array, _origin: unknown, _document: unknown, transaction: { local: boolean }) => {
      if (transaction.local) unsavedLocal = true
    }
    document.on("update", onUpdate)
    onCleanup(() => document.off("update", onUpdate))
  }, { immediate: true })
  watch(() => realtime.saveStatus.value?.savedAt, (savedAt, previous) => {
    if (savedAt && savedAt !== previous) unsavedLocal = false
  })

  watch(realtime.provider, (provider, _previous, onCleanup) => {
    if (!provider) {
      states.value = new Map()
      return
    }
    const onChange = () => {
      states.value = new Map(provider.awareness.getStates())
    }
    provider.awareness.on("change", onChange)
    onChange()
    onCleanup(() => provider.awareness.off("change", onChange))
  }, { immediate: true })

  const others = computed<ConsoleLivePerson[]>(() => {
    const self = realtime.document.value?.clientID
    const byPerson = new Map<string, ConsoleLivePerson>()
    for (const person of realtime.people.value) {
      if (person.clientId === self) continue
      const focus: unknown = states.value.get(person.clientId)?.focus
      const known = byPerson.get(person.id)
      const entry: ConsoleLivePerson = { clientId: person.clientId, color: person.color, id: person.id, name: person.name }
      if (person.image) entry.image = person.image
      if (String(focus) === focus && focus) entry.focus = focus
      if (!known || (!known.focus && entry.focus)) byPerson.set(person.id, entry)
    }
    return [...byPerson.values()]
  })

  const identity = computed(() => {
    const self = realtime.document.value?.clientID
    const person = realtime.people.value.find(entry => entry.clientId === self)
    return person ? { color: person.color, id: person.id, name: person.name } : undefined
  })

  function writeFields(next: Record<string, unknown>): void {
    const map = realtime.fields.value
    const document = realtime.document.value
    if (!map || !document || realtime.readOnly.value || !realtime.synced.value) return
    const current = fieldValue(map.toJSON()) as Record<string, unknown>
    const changed = Object.keys(next).filter(key => stableJson(current[key]) !== stableJson(next[key]))
    const removed = Object.keys(current).filter(key => !Object.hasOwn(next, key))
    if (!changed.length && !removed.length) return
    document.transact(() => {
      for (const key of removed) map.delete(key)
      for (const key of changed) map.set(key, fieldValue(next[key]))
    })
  }

  function focus(field: string | undefined): void {
    realtime.provider.value?.awareness.setLocalStateField("focus", field ?? null)
  }

  async function save(): Promise<string | null> {
    return (await realtime.save()).digest
  }

  onBeforeUnmount(() => focus(undefined))

  return {
    document: realtime.document,
    provider: realtime.provider,
    fields,
    writeFields,
    others,
    focus,
    ready: computed(() => Boolean(realtime.document.value && realtime.synced.value)),
    status: realtime.status,
    readOnlyReason: realtime.readOnlyReason,
    saveStatus: realtime.saveStatus,
    issues: computed(() => realtime.saveStatus.value?.issues ?? []),
    save,
    identity,
  }
}
