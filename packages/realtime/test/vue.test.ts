import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"

import * as decoding from "lib0/decoding"
import * as Y from "yjs"

import { Node as TiptapNode } from "@tiptap/core"
import { encodeRealtimeControl, messageRealtimeControl } from "../src/protocol.ts"
import { RealtimeCaret, useRealtimeTiptap } from "../src/vue.ts"
import { parseHTML } from "linkedom"

const providers = vi.hoisted(() => [] as Array<{
  connect: ReturnType<typeof vi.fn<() => void>>
  destroy: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn<() => void>>
  statusHandler?: (event: { status: string }) => void
  syncHandler?: (value: boolean) => void
  awareness: { on: ReturnType<typeof vi.fn>, setLocalStateField: ReturnType<typeof vi.fn> }
  doc: Y.Doc
  messageHandlers: Array<(encoder: unknown, decoder: decoding.Decoder) => void>
  params: Record<string, string>
  room: string
  ws: { send: ReturnType<typeof vi.fn> }
}>)

const session = vi.hoisted(() => ({ calls: 0 }))

vi.mock("@vite-hub/auth/vue", () => ({
  useUserSession: () => {
    session.calls++
    return { user: ref({ id: "session-user", name: "Session" }) }
  },
}))

vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    awareness = {
      getStates: () => new Map(),
      off: vi.fn(),
      on: vi.fn(),
      setLocalState: vi.fn(),
      setLocalStateField: vi.fn(),
    }

    connect = vi.fn(() => {
      this.wsconnected = true
      this.statusHandler?.({ status: "connected" })
    })
    destroy = vi.fn()
    disconnect = vi.fn(() => {
      this.wsconnected = false
    })
    messageHandlers: Array<(encoder: unknown, decoder: decoding.Decoder) => void> = []
    on = vi.fn((event: string, handler: (value: unknown) => void) => {
      if (event === "status") this.statusHandler = handler as (event: { status: string }) => void
      if (event === "sync") this.syncHandler = handler as (value: boolean) => void
    })
    statusHandler?: (event: { status: string }) => void
    syncHandler?: (value: boolean) => void
    ws = { OPEN: 1, readyState: 1, send: vi.fn() }
    wsconnected = false
    params: Record<string, string> = {}

    constructor(public server: string, public room: string, public doc: Y.Doc) {
      providers.push(this)
    }
  },
}))

const checkpointResponse = {
  digest: "saved",
  document: { body: "# Saved", fields: {} },
  error: null,
  issues: [],
  savedAt: "2026-01-01T00:00:00.000Z",
  savedBy: null,
  snapshot: { createdAt: "2026-01-01T00:00:00.000Z", entries: {}, id: "snapshot" },
}

function control(provider: (typeof providers)[number], message: Parameters<typeof encodeRealtimeControl>[0]) {
  const decoder = decoding.createDecoder(encodeRealtimeControl(message))
  expect(decoding.readVarUint(decoder)).toBe(messageRealtimeControl)
  provider.messageHandlers[messageRealtimeControl]!(undefined, decoder)
}

afterEach(() => {
  session.calls = 0
  vi.useRealTimers()
  providers.length = 0
  vi.unstubAllGlobals()
})

describe("useRealtimeTiptap", () => {
  it("preserves frontmatter through the Vue editor extensions", () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const editor = new Editor({
      extensions: realtime.extensions.value,
      content: "---\n---\n\n# Page",
      contentType: "markdown",
    })

    expect(editor.getJSON().content?.map(node => node.type)).toEqual(["frontmatter", "heading"])
    expect(editor.getMarkdown()).toBe("---\n---\n\n# Page")

    editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Before" }] })
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(["frontmatter", "heading"])

    editor.commands.deleteRange({ from: 1, to: editor.state.doc.content.size })
    expect(editor.getJSON().content?.map(node => node.type)).toEqual(["frontmatter", "paragraph"])

    editor.destroy()
    scope.stop()
  })

  it("connects providers only while enabled", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const enabled = ref(false)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { enabled }))!

    expect(providers).toHaveLength(1)
    expect(providers[0]!.connect).not.toHaveBeenCalled()
    expect(realtime.document.value).toBeUndefined()
    realtime.workspace.notify({ operation: "delete", path: "private.md" })

    enabled.value = true
    await nextTick()
    expect(providers).toHaveLength(2)
    expect(providers[0]!.connect).toHaveBeenCalledOnce()
    expect(providers[0]!.ws.send).not.toHaveBeenCalled()
    expect(realtime.document.value).toBeDefined()

    enabled.value = false
    await nextTick()
    expect(providers[0]!.disconnect).toHaveBeenCalled()
    expect(providers[1]!.destroy).toHaveBeenCalledOnce()
    expect(realtime.document.value).toBeUndefined()

    enabled.value = true
    await nextTick()
    expect(providers).toHaveLength(3)
    expect(providers[0]!.connect).toHaveBeenCalledTimes(2)
    expect(realtime.document.value).toBeDefined()
    scope.stop()
    expect(providers[0]!.destroy).toHaveBeenCalledOnce()
    expect(providers[2]!.destroy).toHaveBeenCalledOnce()
  })

  it("sends only its own awareness state, never other clients' states that it received", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { identity: { id: "ana", name: "Ana" } }))
    const provider = providers.at(-1)!
    Object.assign(provider, { wsconnected: true })
    const handler = provider.awareness.on.mock.calls.find(([event]) => event === "update")![1] as (change: { added: number[], removed: number[], updated: number[] }) => void
    Object.assign(provider.awareness, { getStates: () => new Map([[provider.doc.clientID, { user: { id: "ana" } }], [42, { user: { id: "ben" } }]]), meta: new Map([[provider.doc.clientID, { clock: 1, lastUpdated: 0 }], [42, { clock: 1, lastUpdated: 0 }]]), states: new Map([[provider.doc.clientID, { user: { id: "ana" } }], [42, { user: { id: "ben" } }]]) })
    handler({ added: [42], removed: [], updated: [] })
    expect(provider.ws.send).not.toHaveBeenCalled()
    handler({ added: [], removed: [], updated: [provider.doc.clientID, 42] })
    expect(provider.ws.send).toHaveBeenCalledOnce()
    scope.stop()
  })

  it("ignores lifecycle events from replaced document providers", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const documentId = ref("first.md")
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", documentId))!
    const first = providers[1]!

    first.statusHandler?.({ status: "connected" })
    first.syncHandler?.(true)
    expect(realtime.status.value).toBe("connected")
    expect(realtime.synced.value).toBe(true)

    documentId.value = "second.md"
    await nextTick()
    const second = providers[2]!
    second.statusHandler?.({ status: "connected" })
    second.syncHandler?.(true)
    first.statusHandler?.({ status: "disconnected" })
    first.syncHandler?.(false)

    expect(realtime.status.value).toBe("connected")
    expect(realtime.synced.value).toBe(true)
    scope.stop()
  })

  it("paces queued Workspace changes below the server quota", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const workspaceProvider = providers[0]!
    workspaceProvider.disconnect()
    vi.useFakeTimers()

    for (let index = 0; index <= 100; index++) {
      realtime.workspace.notify({ operation: "update", path: `${index}.md` })
    }
    expect(workspaceProvider.ws.send).not.toHaveBeenCalled()

    workspaceProvider.connect()
    expect(workspaceProvider.ws.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(workspaceProvider.ws.send).toHaveBeenCalledTimes(101)
    scope.stop()
  })

  it("keeps checkpoint pending state honest across overlapping failures", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const responses: Array<(response: Response) => void> = []
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!

    const first = realtime.history.checkpoint()
    const second = realtime.history.checkpoint()
    expect(realtime.history.pending.value).toBe(true)

    responses[0]!(new Response(JSON.stringify(checkpointResponse)))
    await expect(first).resolves.toEqual([undefined, checkpointResponse])
    expect(realtime.history.pending.value).toBe(true)

    responses[1]!(new Response(JSON.stringify({ message: "publisher unavailable", statusMessage: "" }), { status: 500 }))
    await expect(second).resolves.toMatchObject([{
      code: "REALTIME_REQUEST_FAILED",
      why: "The realtime `checkpoint()` request failed with HTTP 500: publisher unavailable",
    }, undefined])
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("rejects malformed successful checkpoint responses", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ digest: "saved", document: { body: "# Saved" } }))))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!

    await expect(realtime.history.checkpoint()).resolves.toMatchObject([{
      code: "REALTIME_INVALID_RESPONSE",
      docs: "https://vitehub.dev/docs/realtime/limits-and-errors#realtime_invalid_response",
    }, undefined])
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("rejects checkpoints without entering pending state while disabled", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { enabled: false }))!

    await expect(realtime.history.checkpoint()).resolves.toMatchObject([{ code: "REALTIME_DISABLED" }, undefined])
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("aborts an in-flight checkpoint when the composable is destroyed", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true })
    })))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const checkpoint = realtime.history.checkpoint()
    const timed = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for checkpoint cancellation")), 100)
    })

    realtime.destroy()

    await expect(Promise.race([checkpoint, timed])).resolves.toMatchObject([{ code: "REALTIME_DISCONNECTED" }, undefined])
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("aborts a checkpoint while consuming the response body", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    let rejectBody!: (error: unknown) => void
    const body = new Promise<unknown>((_resolve, reject) => { rejectBody = reject })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => body,
    }))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const checkpoint = realtime.history.checkpoint()

    await Promise.resolve()
    realtime.destroy()
    rejectBody(new DOMException("The operation was aborted.", "AbortError"))

    await expect(checkpoint).resolves.toMatchObject([{ code: "REALTIME_DISCONNECTED" }, undefined])
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("rejects a checkpoint during a same-tick document switch", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(checkpointResponse)))
    vi.stubGlobal("fetch", fetch)
    const documentId = ref("first.md")
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", documentId))!
    realtime.document.value!.getText("content").insert(0, "First document")

    documentId.value = "second.md"
    const pending = realtime.history.checkpoint()
    await expect(pending).resolves.toMatchObject([{ code: "REALTIME_DISCONNECTED" }, undefined])
    expect(fetch).not.toHaveBeenCalled()
    expect(realtime.history.pending.value).toBe(false)

    await nextTick()
    await expect(realtime.history.checkpoint()).resolves.toMatchObject([undefined, { document: { body: "# Saved" } }])
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe("/api/_vitehub/realtime/docs/second.md?history=checkpoint")
    scope.stop()
  })

  it.each(["switch", "switch-back", "disable", "destroy", "dispose"] as const)("stops checkpoint retries after document %s", async (operation) => {
    vi.useFakeTimers()
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { code: "REALTIME_SYNC_PENDING" } }), { status: 409 }))
      .mockResolvedValue(new Response(JSON.stringify(checkpointResponse)))
    vi.stubGlobal("fetch", fetch)
    const documentId = ref("first.md")
    const enabled = ref(true)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", documentId, { enabled }))!
    const pending = realtime.history.checkpoint().then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)

    if (operation === "switch" || operation === "switch-back") documentId.value = "second.md"
    else if (operation === "disable") enabled.value = false
    else if (operation === "destroy") realtime.destroy()
    else scope.stop()
    await nextTick()
    if (operation === "switch-back") {
      documentId.value = "first.md"
      await nextTick()
    }
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toMatchObject({ value: [{ code: "REALTIME_DISCONNECTED" }, undefined] })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("retries a checkpoint while the room is still syncing", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { code: "REALTIME_SYNC_PENDING" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(checkpointResponse)))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!

    await expect(realtime.history.checkpoint()).resolves.toEqual([undefined, checkpointResponse])
    expect(fetch).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it("uses an injected identity and editor schema instead of the app session and default kit", () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const identity = ref({ id: "console:ana", image: "https://example.com/ana.png", name: "Ana" })
    const Callout = TiptapNode.create({ name: "callout", group: "block", content: "inline*" })
    const extensions = vi.fn(() => [TiptapNode.create({ name: "doc", topNode: true, content: "block+" }), TiptapNode.create({ name: "paragraph", group: "block", content: "inline*" }), TiptapNode.create({ name: "text", group: "inline" }), Callout])
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { editor: { extensions }, identity }))!

    expect(session.calls).toBe(0)
    expect(realtime.extensions.value.map(extension => extension.name)).toEqual(["doc", "paragraph", "text", "callout", "collaboration", "collaborationCaret"])
    expect(providers[1]!.awareness.setLocalStateField).toHaveBeenCalledWith("user", expect.objectContaining({ id: "console:ana", name: "Ana" }))
    scope.stop()
  })

  it("adds other people's carets unless carets is false", () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const [withCarets, withoutCarets] = scope.run(() => [
      useRealtimeTiptap("docs", ref("page.md")),
      useRealtimeTiptap("docs", ref("other.md"), { carets: false }),
    ])!

    expect(withCarets.extensions.value.map(extension => extension.name)).toContain("collaborationCaret")
    expect(withoutCarets.extensions.value.map(extension => extension.name)).not.toContain("collaborationCaret")
    scope.stop()
  })

  it("draws carets with TipTap's CollaborationCaret classes and rejects colors y-tiptap cannot tint", () => {
    const { document } = parseHTML("<!doctype html><html><body></body></html>")
    vi.stubGlobal("document", document)
    const { render, selectionRender } = RealtimeCaret.configure({}).options

    const caret = render({ color: "#2563EB", name: "Ana" })
    expect(caret.className).toBe("collaboration-carets__caret")
    expect(caret.querySelector(".collaboration-carets__label")!.textContent).toBe("Ana")
    expect(selectionRender({ color: "#2563EB", name: "Ana" })).toEqual({ class: "ProseMirror-yjs-selection", style: "background-color: #2563EB70" })
  })

  it("defaults presence to the ViteHub Auth session", () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    scope.run(() => useRealtimeTiptap("docs", ref("page.md")))
    expect(session.calls).toBe(1)
    expect(providers[1]!.awareness.setLocalStateField).toHaveBeenCalledWith("user", expect.objectContaining({ id: "session-user", name: "Session" }))
    scope.stop()
  })

  it("binds the session epoch and access, and exposes fields and server status", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const provider = providers[1]!

    control(provider, { type: "session", access: "read", epoch: "seed-1" })
    expect(provider.params.epoch).toBe("seed-1")
    expect(realtime.readOnly.value).toBe(true)
    expect(realtime.readOnlyReason.value).toBe("access")
    control(provider, { type: "session", access: "read", epoch: "seed-1", reason: "document" })
    expect(realtime.readOnlyReason.value).toBe("document")
    control(provider, { type: "session", access: "write", epoch: "seed-1" })
    expect(realtime.readOnly.value).toBe(false)
    expect(realtime.readOnlyReason.value).toBeNull()

    const remote = new Y.Doc()
    remote.getMap("fields").set("title", "Hello")
    remote.getMap("status").set("digest", "d1")
    remote.getMap("status").set("issues", [{ field: "title", message: "Too short", path: [] }])
    Y.applyUpdate(provider.doc, Y.encodeStateAsUpdate(remote))
    expect(realtime.fields.value?.get("title")).toBe("Hello")
    expect(realtime.saveStatus.value).toMatchObject({ digest: "d1", issues: [{ field: "title", message: "Too short" }] })
    remote.destroy()
    scope.stop()
  })

  it("drops its Yjs state and reconnects when the room is re-seeded", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const onReset = vi.fn((event: { previous: Y.Doc }) => event.previous.getMap("fields").get("title"))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { onReset }))!
    const listener = vi.fn()
    realtime.onReset(listener)
    const first = providers[1]!
    const firstDocument = realtime.document.value!
    firstDocument.getMap("fields").set("title", "Unsaved")
    control(first, { type: "session", access: "write", epoch: "seed-1" })

    control(first, { type: "reset", epoch: "seed-2", reason: "source-changed" })

    expect(onReset).toHaveBeenCalledWith(expect.objectContaining({ epoch: "seed-2", reason: "source-changed" }))
    expect(onReset.mock.results[0]!.value).toBe("Unsaved")
    expect(listener).toHaveBeenCalledOnce()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(providers).toHaveLength(3)
    expect(providers[2]!.params.epoch).toBeUndefined()
    expect(realtime.document.value).not.toBe(firstDocument)
    expect(realtime.document.value!.getMap("fields").get("title")).toBeUndefined()
    expect(realtime.extensions.value.find(extension => extension.name === "collaboration")!.options.fragment).toBe(realtime.document.value!.getXmlFragment("body"))
    scope.stop()
  })

  it("saves through the document endpoint and refreshes without a body", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const { snapshot: _snapshot, ...saved } = checkpointResponse
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(saved)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ digest: "saved", reseeded: false })))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("guides/page.md")))!

    await expect(realtime.save()).resolves.toMatchObject([undefined, { digest: "saved", document: { body: "# Saved" } }])
    expect(fetch.mock.calls[0]![0]).toBe("/api/_vitehub/realtime/docs/guides/page.md?document=save")
    expect(realtime.saving.value).toBe(false)
    await expect(realtime.refresh()).resolves.toEqual([undefined, { digest: "saved", reseeded: false }])
    expect(fetch.mock.calls[1]![0]).toBe("/api/_vitehub/realtime/docs/guides/page.md?document=refresh")
    expect(fetch.mock.calls[1]![1].body).toBeUndefined()
    scope.stop()
  })
})
