import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import type { RealtimeDefinition } from "../src/types.ts"
import { RealtimeDocumentConflict } from "../src/conflict.ts"
import { defineRealtimeEditor } from "../src/editor.ts"
import { createRealtimeYDoc, readRealtimeYDoc } from "../src/document.ts"
import { readRealtimeStatus } from "../src/layout.ts"
import { createRealtimeHandler, realtimeRoomKey, refreshRealtimeDocument } from "../src/server.ts"
import { FakeSql, appendParagraph, createMemoryAdapter, createStubEditor, createTestServer, paragraphs, registryOf, sendAwareness, settle } from "./harness.ts"

const serverMocks = vi.hoisted(() => ({
  resolveWorkspaceStoreTarget: vi.fn(),
  useWorkspace: vi.fn(),
}))

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: vi.fn(async () => {
    throw new Error("The ViteHub Auth session must not be used when identify() is defined.")
  }),
}))

vi.mock("@vite-hub/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vite-hub/workspace")>(),
  resolveWorkspaceStoreTarget: serverMocks.resolveWorkspaceStoreTarget,
  useWorkspace: serverMocks.useWorkspace,
}))

beforeEach(() => {
  vi.useFakeTimers()
  serverMocks.resolveWorkspaceStoreTarget.mockReset().mockResolvedValue(undefined)
  serverMocks.useWorkspace.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Clients may send one document update per 50 ms. */
async function pace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60)
}

function liveDefinition(adapter: RealtimeDefinition["document"], extra: Partial<RealtimeDefinition> = {}): RealtimeDefinition {
  return { document: adapter, editor: createStubEditor().editor, ...extra }
}

describe("custom document adapters", () => {
  it("seeds fields and body from load() and saves both after the idle debounce", async () => {
    const memory = createMemoryAdapter({ "posts/hello": { body: "Hello", fields: { tags: ["news"], title: "Draft" } } })
    const server = createTestServer(liveDefinition(memory.adapter))

    const client = await server.connect("posts/hello")
    await settle()

    expect(client.controls[0]).toMatchObject({ type: "session", access: "write" })
    expect(paragraphs(client.doc)).toEqual(["Hello"])
    expect(client.doc.getMap("fields").toJSON()).toEqual({ tags: ["news"], title: "Draft" })
    expect(readRealtimeStatus(client.doc)).toMatchObject({ digest: "v1", issues: [], savedAt: null })
    expect(memory.adapter.load).toHaveBeenCalledWith({ authority: "memory", definition: "docs", documentId: "posts/hello" })

    await pace()
    client.doc.transact(() => {
      appendParagraph(client.doc, "World")
      client.doc.getMap("fields").set("title", "Final")
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(memory.adapter.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await settle()

    expect(memory.adapter.save).toHaveBeenCalledOnce()
    expect(memory.adapter.save.mock.calls[0]!.slice(1)).toEqual([
      { body: "Hello\n\nWorld", fields: { tags: ["news"], title: "Final" } },
      { editors: [], ifDigest: "v1", reason: "idle", user: undefined },
    ])
    expect(readRealtimeStatus(client.doc)).toMatchObject({ digest: "v2", error: null, issues: [], savedBy: null })
    expect(readRealtimeStatus(client.doc).savedAt).toEqual(expect.any(String))
    client.close()
  })

  it("caps continuous editing at maxWait and saves when the last client leaves", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()

    for (let second = 0; second < 9; second++) {
      appendParagraph(client.doc, `Edit ${second}`)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(memory.adapter.save).not.toHaveBeenCalled()
    appendParagraph(client.doc, "Edit 9")
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(memory.adapter.save).toHaveBeenCalledOnce()
    expect(memory.adapter.save.mock.calls[0]![2]).toMatchObject({ reason: "idle" })

    await pace()
    appendParagraph(client.doc, "Last words")
    client.close()
    await settle()
    expect(memory.adapter.save).toHaveBeenCalledTimes(2)
    expect(memory.adapter.save.mock.calls[1]![2]).toMatchObject({ reason: "leave" })
    expect(memory.store.get("page")!.body).toContain("Last words")
  })

  it("saves only on request when persistence is disabled", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter, { persistence: false }))
    const client = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(client.doc, "Edit")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(memory.adapter.save).not.toHaveBeenCalled()

    const response = await server.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ digest: "v2", document: { body: "Start\n\nEdit" } })
    expect(memory.adapter.save.mock.calls[0]![2]).toMatchObject({ reason: "request" })
    client.close()
  })

  it("merges the adapter's stored form and reports issues without resetting clients", async () => {
    const memory = createMemoryAdapter({ page: { body: "hello", fields: { title: "" } } }, {
      issues: document => document.fields?.title ? [] : [{ field: "title", message: "Title is required", path: [] }],
      normalize: document => ({ body: document.body.toUpperCase(), fields: { ...document.fields, slug: "hello" } }),
    })
    const server = createTestServer(liveDefinition(memory.adapter))
    const first = await server.connect("page")
    const second = await server.connect("page")
    await settle()
    await pace()

    appendParagraph(first.doc, "draft")
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    for (const client of [first, second]) {
      expect(client.closed).toBeUndefined()
      expect(client.controls.filter(control => control.type === "reset")).toEqual([])
      expect(paragraphs(client.doc)).toEqual(["HELLO", "DRAFT"])
      expect(client.doc.getMap("fields").toJSON()).toEqual({ slug: "hello", title: "" })
      expect(readRealtimeStatus(client.doc).issues).toEqual([{ field: "title", message: "Title is required", path: [] }])
    }
    // The merge is a server write: it does not schedule another save.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(memory.adapter.save).toHaveBeenCalledOnce()
    first.close()
    second.close()
  })

  it("records a failed save in status and retries with backoff", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    memory.adapter.save.mockRejectedValueOnce(new Error("Database unavailable"))
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(client.doc, "Edit")

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(readRealtimeStatus(client.doc).error).toBe("Database unavailable")
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(memory.adapter.save).toHaveBeenCalledTimes(2)
    expect(readRealtimeStatus(client.doc)).toMatchObject({ digest: "v2", error: null })
    client.close()
  })

  it("round-trips through an async editor codec without changing the stored Markdown", async () => {
    const { calls, editor } = createStubEditor()
    const body = "First  paragraph\n\n\n\nAfter an empty paragraph"
    const document = await createRealtimeYDoc(editor, { body, fields: { order: 2 } })
    expect(await readRealtimeYDoc(editor, document)).toEqual({ body, fields: { order: 2 } })
    expect(calls).toEqual({ fromMarkdown: 1, toMarkdown: 1 })

    const memory = createMemoryAdapter({ page: { body } })
    const server = createTestServer({ document: memory.adapter, editor })
    const client = await server.connect("page")
    await settle()
    await pace()
    client.doc.getMap("fields").set("reviewed", true)
    const response = await server.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })
    expect(response.status).toBe(200)
    expect(memory.adapter.save.mock.calls[0]![1]).toEqual({ body, fields: { reviewed: true } })
    document.destroy()
    client.close()
  })
})

/**
 * Stub codec that loses a construct: blocks starting with `::` (an undeclared component) are
 * dropped. It also writes `- ` for a `* ` list marker and drops the final newline.
 */
function createLossyEditor() {
  const { calls, editor: base } = createStubEditor()
  const blocks = (markdown: string) => markdown.replace(/\n+$/, "").split("\n\n")
  const kept = (markdown: string) => blocks(markdown).filter(block => !block.startsWith("::")).map(block => block.replace(/^\* /, "- ")).join("\n\n")
  const verify = vi.fn((markdown: string) => {
    const lost = blocks(markdown).filter(block => block.startsWith("::"))
    return lost.length
      ? { issues: lost.map(block => ({ message: `The editor does not know ${block.split("\n")[0]}.` })), writable: false }
      : { canonical: kept(markdown), writable: true }
  })
  const editor = defineRealtimeEditor({
    extensions: base.extensions,
    fromMarkdown: markdown => base.fromMarkdown(kept(markdown)),
    toMarkdown: document => base.toMarkdown(document),
    verify,
  })
  return { calls, editor, verify }
}

describe("editor codec guard", () => {
  it("opens a document the codec cannot keep as read-only and never saves it", async () => {
    const { editor, verify } = createLossyEditor()
    const body = "Intro\n\n::callout\nKeep me\n::\n\nOutro\n"
    const memory = createMemoryAdapter({ page: { body, fields: { title: "Notes" } } })
    const server = createTestServer({ document: memory.adapter, editor })
    const client = await server.connect("page")
    await settle()

    expect(verify).toHaveBeenCalledWith(body, { fields: { title: "Notes" } })
    expect(client.controls[0]).toEqual({ type: "session", access: "read", epoch: expect.any(String), reason: "document" })
    expect(paragraphs(client.doc)).toEqual(["Intro", "Outro"])
    expect(readRealtimeStatus(client.doc)).toMatchObject({
      digest: "v1",
      error: "The editor cannot save this document without loss. The room is read-only.",
      issues: [{ message: "The editor does not know ::callout." }],
    })

    const save = await server.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })
    expect(save.status).toBe(409)
    await expect(save.json()).resolves.toMatchObject({ data: { code: "REALTIME_READ_ONLY" } })

    await pace()
    client.doc.getMap("fields").set("title", "Changed")
    expect(client.closed).toEqual({ code: 4403, reason: "This realtime document is read-only: the editor cannot save it without loss." })
    const second = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(second.doc, "Edit")
    expect(second.closed?.code).toBe(4403)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(memory.adapter.save).not.toHaveBeenCalled()
    expect(memory.store.get("page")).toMatchObject({ body, digest: "v1" })
  })

  it("opens writable again after the stored document is fixed", async () => {
    const { editor } = createLossyEditor()
    const memory = createMemoryAdapter({ page: { body: "Intro\n\n::callout" } })
    const server = createTestServer({ document: memory.adapter, editor })
    const client = await server.connect("page")
    await settle()
    expect(client.controls[0]).toMatchObject({ access: "read", reason: "document" })

    memory.write("page", "Intro\n\nOutro")
    await server.post("page", "refresh")
    expect(client.closed?.code).toBe(4409)
    const fresh = await server.connect("page")
    await settle()
    expect(fresh.controls[0]).toEqual({ type: "session", access: "write", epoch: expect.any(String) })
    expect(readRealtimeStatus(fresh.doc)).toMatchObject({ error: null, issues: [] })
    fresh.close()
  })

  it("writes nothing when the room only holds the codec's form of the stored document", async () => {
    const { editor } = createLossyEditor()
    const memory = createMemoryAdapter({ page: { body: "* item\n\nText\n", fields: { title: "List" } } })
    const server = createTestServer({ document: memory.adapter, editor })
    const client = await server.connect("page")
    await settle()
    expect(client.controls[0]).toMatchObject({ access: "write" })
    expect(paragraphs(client.doc)).toEqual(["- item", "Text"])

    // An edit that is undone leaves the canonical form: no save, no rewrite of `* item`.
    await pace()
    appendParagraph(client.doc, "Typo")
    await pace()
    client.doc.getXmlFragment("body").delete(2, 1)
    expect(paragraphs(client.doc)).toEqual(["- item", "Text"])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(memory.adapter.save).not.toHaveBeenCalled()
    expect(readRealtimeStatus(client.doc)).toMatchObject({ digest: "v1", error: null })

    // A real edit saves the codec's form and keeps the final newline.
    appendParagraph(client.doc, "More")
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(memory.adapter.save).toHaveBeenCalledOnce()
    expect(memory.store.get("page")).toMatchObject({ body: "- item\n\nText\n\nMore\n", fields: { title: "List" } })
    expect(readRealtimeStatus(client.doc)).toMatchObject({ digest: "v2", issues: [] })
    client.close()
  })

  it("saves output the codec cannot read back and reports an issue", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()
    await pace()
    // The stub codec splits paragraphs on blank lines, so this paragraph reads back as two.
    appendParagraph(client.doc, "one\n\ntwo")
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    expect(memory.store.get("page")!.body).toBe("Start\n\none\n\ntwo")
    expect(readRealtimeStatus(client.doc)).toMatchObject({
      digest: "v2",
      error: null,
      issues: [{ message: "The editor cannot read back the Markdown that it saved. Some content can change when the document opens again." }],
    })
    client.close()
  })
})

describe("server-written status", () => {
  it("closes clients that write the status map and keeps the room status", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const honest = await server.connect("page")
    const forger = await server.connect("page")
    await settle()
    await pace()

    forger.doc.getMap("status").set("digest", "forged")

    expect(forger.closed).toEqual({ code: 4403, reason: "Realtime document status is written by the server." })
    expect(readRealtimeStatus(honest.doc).digest).toBe("v1")
    const fresh = await server.connect("page")
    expect(readRealtimeStatus(fresh.doc).digest).toBe("v1")
    honest.close()
    fresh.close()
  })
})

describe("re-seeding", () => {
  it("resets every client when the stored document changed outside the room, without duplicating content", async () => {
    const memory = createMemoryAdapter({ page: { body: "Original" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const ana = await server.connect("page")
    const ben = await server.connect("page")
    await settle()
    const firstEpoch = ana.controls[0]!.epoch
    await pace()
    appendParagraph(ana.doc, "Unsaved by Ana")
    memory.write("page", "Agent rewrite")

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    for (const client of [ana, ben]) {
      expect(client.controls.at(-1)).toEqual({ type: "reset", epoch: expect.any(String), reason: "source-changed" })
      expect(client.closed?.code).toBe(4409)
    }
    const secondEpoch = ana.controls.at(-1)!.epoch
    expect(secondEpoch).not.toBe(firstEpoch)
    // Ana still holds her unsaved paragraph locally; the reset event hands it to the UI.
    expect(paragraphs(ana.doc)).toEqual(["Original", "Unsaved by Ana"])

    // A client that ignores the reset and reconnects with its old seed is refused, not merged.
    const stale = await server.connect("page", { doc: ana.doc, epoch: firstEpoch })
    expect(stale.controls).toEqual([{ type: "reset", epoch: secondEpoch, reason: "stale" }])
    expect(stale.closed?.code).toBe(4409)

    const ana2 = await server.connect("page")
    const ben2 = await server.connect("page")
    await settle()
    expect(ana2.controls[0]).toEqual({ type: "session", access: "write", epoch: secondEpoch })
    expect(paragraphs(ana2.doc)).toEqual(["Agent rewrite"])
    expect(paragraphs(ben2.doc)).toEqual(["Agent rewrite"])

    await pace()
    appendParagraph(ben2.doc, "Ben continues")
    expect(paragraphs(ana2.doc)).toEqual(["Agent rewrite", "Ben continues"])
    ana2.close()
    ben2.close()
    await settle()
    expect(memory.store.get("page")!.body).toBe("Agent rewrite\n\nBen continues")
  })

  it("re-seeds a clean room on refresh and reports when nothing changed", async () => {
    const memory = createMemoryAdapter({ page: { body: "Original" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()

    const unchanged = await server.post("page", "refresh")
    await expect(unchanged.json()).resolves.toEqual({ digest: "v1", reseeded: false })
    expect(client.closed).toBeUndefined()

    memory.write("page", "External")
    const changed = await server.post("page", "refresh")
    await expect(changed.json()).resolves.toEqual({ digest: expect.stringMatching(/^external-/), reseeded: true })
    expect(client.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })

    const dirty = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(dirty.doc, "Unsaved")
    memory.write("page", "Outside")
    const deferred = await server.post("page", "refresh")
    await expect(deferred.json()).resolves.toEqual({ digest: expect.any(String), reseeded: false })
    expect(dirty.closed).toBeUndefined()
    expect(paragraphs(dirty.doc)).toContain("Unsaved")
    dirty.close()
  })
})

describe("identity and authorization", () => {
  function secured(memory: ReturnType<typeof createMemoryAdapter>, extra: Partial<RealtimeDefinition> = {}) {
    return liveDefinition(memory.adapter, {
      authorize: ({ documentId, mode, user }) => {
        if (documentId === "secret") return user?.id === "ana"
        if (mode === "write") return user?.id !== "viewer"
      },
      identify: ({ request }) => {
        const id = request.headers.get("x-user")
        return id ? { id, image: `https://example.com/${id}.png`, name: id.toUpperCase() } : null
      },
      ...extra,
    })
  }

  it("uses identify() for presence and save attribution instead of the app session", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(secured(memory))
    const ana = await server.connect("page", { headers: { "x-user": "ana" } })
    const ben = await server.connect("page", { headers: { "x-user": "ben" } })
    await settle()
    await pace()

    sendAwareness(ana, { user: { color: "#000000", id: "mallory", name: "Mallory" } })
    const presence = new awarenessProtocol.Awareness(new Y.Doc())
    awarenessProtocol.applyAwarenessUpdate(presence, ben.awareness.at(-1)!, "test")
    expect(presence.getStates().get(ana.doc.clientID)?.user).toMatchObject({ id: "ana", image: "https://example.com/ana.png", name: "ANA" })

    appendParagraph(ben.doc, "Ben")
    await pace()
    appendParagraph(ana.doc, "Ana")
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(memory.adapter.save.mock.calls[0]![2]).toMatchObject({
      editors: [{ id: "ben", image: "https://example.com/ben.png", name: "BEN" }, { id: "ana", image: "https://example.com/ana.png", name: "ANA" }],
      user: { id: "ana", name: "ANA" },
    })
    expect(readRealtimeStatus(ana.doc).savedBy).toMatchObject({ id: "ana" })
    presence.destroy()
    ana.close()
    ben.close()
  })

  it("denies reads, makes write-denied connections read-only, and rejects cross-origin requests", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" }, secret: { body: "Secret" } })
    const server = createTestServer(secured(memory))

    expect((await server.connect("secret", { headers: { "x-user": "ben" } })).closed).toEqual({ code: 403, reason: "rejected" })
    expect((await server.connect("secret", { headers: { "x-user": "ana" } })).closed).toBeUndefined()
    expect((await server.connect("page", { headers: { origin: "https://evil.example", "x-user": "ana" } })).closed).toEqual({ code: 403, reason: "rejected" })

    const viewer = await server.connect("page", { headers: { "x-user": "viewer" } })
    await settle()
    expect(viewer.controls[0]).toMatchObject({ type: "session", access: "read" })
    expect(paragraphs(viewer.doc)).toEqual(["Start"])
    await pace()
    appendParagraph(viewer.doc, "Vandalism")
    expect(viewer.closed).toEqual({ code: 4403, reason: "This realtime connection is read-only." })

    const save = await server.post("page", "save", { headers: { "x-user": "viewer" }, state: Y.encodeStateAsUpdate(viewer.doc) })
    expect(save.status).toBe(403)
    const refresh = await server.post("page", "refresh", { headers: { "x-user": "viewer" } })
    expect(refresh.status).toBe(200)

    const editor = await server.connect("page", { headers: { "x-user": "ana" } })
    expect(paragraphs(editor.doc)).toEqual(["Start"])
  })

  it("requires an identity when auth is true", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(secured(memory, { auth: true }))

    expect((await server.connect("page")).closed).toEqual({ code: 401, reason: "rejected" })
    expect((await server.connect("page", { headers: { "x-user": "ana" } })).closed).toBeUndefined()
  })

  it("refuses a rejected upgrade instead of opening a socket without hooks", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(secured(memory, { auth: true }))

    const { response } = await server.connect("page")
    const hooks = (response as Response & { crossws?: { open?: unknown, upgrade?: (request: Request) => unknown } }).crossws
    // crossws upgrades a response without hooks into a silent socket; only an upgrade hook can refuse it.
    expect(response.status).toBe(401)
    expect(hooks?.open).toBeUndefined()
    const refusal = await hooks?.upgrade?.(new Request("https://example.com"))
    expect(refusal).toBeInstanceOf(Response)
    expect((refusal as Response).status).toBe(401)
  })
})

describe("history checkpoints", () => {
  it("saves and records history through the adapter in one room operation", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const snapshot = { createdAt: "2026-10-14T00:00:00.000Z", entries: { page: { digest: "v2", type: "file" as const } }, id: "snapshot-1" }
    const checkpoint = vi.fn(async () => snapshot)
    const server = createTestServer(liveDefinition({ ...memory.adapter, checkpoint }, { history: { checkpoint: { message: "Publish" } } }))
    const client = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(client.doc, "Edit")

    const response = await server.post("page", "checkpoint", { state: Y.encodeStateAsUpdate(client.doc) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ digest: "v2", document: { body: "Start\n\nEdit" }, snapshot })
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ documentId: "page" }), { digest: "v2", message: "Publish", user: undefined })
    client.close()
  })

  it("rebases a conflicting Workspace checkpoint and re-seeds when the remote version wins", async () => {
    let content = "Base"
    let digest = "baseline"
    let checkpoints = 0
    const rebase = vi.fn(async () => {
      content = "Remote"
      digest = "remote"
    })
    serverMocks.useWorkspace.mockReturnValue({
      capabilities: vi.fn().mockResolvedValue({ conditionalWrites: true }),
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn(async () => content),
        stat: vi.fn(async () => ({ digest })),
        writeFile: vi.fn(async (_path: string, next: string) => {
          content = next
          digest = "staged"
          return "page.md"
        }),
      },
      history: {
        checkpoint: vi.fn(async () => {
          if (checkpoints++ === 0) throw Object.assign(new Error("remote moved"), { code: "WORKSPACE_CONFLICT", name: "ViteHubError" })
          return { createdAt: "2026-10-14T00:00:00.000Z", entries: { "page.md": { digest, type: "file" } }, id: "snapshot" }
        }),
        rebase,
      },
    })
    const server = createTestServer({ document: { workspace: "docs" }, editor: createStubEditor().editor, history: { checkpoint: true } })
    const client = await server.connect("page.md")
    await settle()
    await pace()
    appendParagraph(client.doc, "Local")

    const response = await server.post("page.md", "checkpoint", { state: Y.encodeStateAsUpdate(client.doc) })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ data: { code: "REALTIME_SOURCE_CHANGED" } })
    expect(rebase).toHaveBeenCalledWith({ takeRemote: ["page.md"] })
    expect(client.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    const fresh = await server.connect("page.md")
    await settle()
    expect(paragraphs(fresh.doc)).toEqual(["Remote"])
  })
})

describe("room authorities", () => {
  it("keeps memory rooms with unsaved edits and releases them once saved", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()
    await pace()
    appendParagraph(client.doc, "Edit")
    client.close()
    await settle()
    expect(memory.adapter.save).toHaveBeenCalledOnce()

    // A clean, released room reopens from its live state without another load.
    const again = await server.connect("page")
    await settle()
    expect(paragraphs(again.doc)).toEqual(["Start", "Edit"])
    expect(memory.adapter.load).toHaveBeenCalledOnce()
  })

  it("restores Durable Object state with its seed, saves dirty state on wake, and re-seeds stale clients", async () => {
    const sql = new FakeSql()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    memory.adapter.save.mockRejectedValueOnce(new Error("Database unavailable"))
    const definition = liveDefinition(memory.adapter)
    const first = createTestServer(definition, { durable: sql })
    const client = await first.connect("page")
    await settle()
    expect(sql.alterJournalAttempted).toBe(true)
    const epoch = client.controls[0]!.epoch
    await pace()
    appendParagraph(client.doc, "Edit")
    client.close()
    await settle()

    // The leave save failed: the Durable Object kept the unsaved Yjs state and marked it dirty.
    const key = realtimeRoomKey("docs", "page")
    expect(sql.documents.get(key)).toMatchObject({ digest: "v1", dirty: 1, epoch })

    const restarted = createTestServer(definition, { durable: sql })
    const reconnecting = await restarted.connect("page", { doc: client.doc, epoch })
    await settle()
    expect(reconnecting.controls[0]).toEqual({ type: "session", access: "write", epoch })
    expect(paragraphs(reconnecting.doc)).toEqual(["Start", "Edit"])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(memory.store.get("page")!.body).toBe("Start\n\nEdit")
    expect(sql.documents.get(key)).toMatchObject({ digest: "v2", dirty: 0, epoch })
    reconnecting.close()
    await settle()

    memory.write("page", "Changed elsewhere")
    const later = createTestServer(definition, { durable: sql })
    const stale = await later.connect("page", { doc: reconnecting.doc, epoch })
    expect(stale.controls).toEqual([{ type: "reset", epoch: expect.not.stringMatching(epoch), reason: "stale" }])
    const fresh = await later.connect("page")
    await settle()
    expect(paragraphs(fresh.doc)).toEqual(["Changed elsewhere"])
  })

  it("accepts the intermediate Durable Object journal schema without client_update", async () => {
    const sql = new FakeSql({ intermediateJournal: true })
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(liveDefinition(memory.adapter), { durable: sql })
    const client = await server.connect("page")
    await settle()
    appendParagraph(client.doc, "Edit")
    await settle()

    expect(sql.alterJournalAttempted).toBe(true)
    expect(sql.updates).toHaveLength(1)
    expect(sql.updates[0]).toMatchObject({ client_update: 1 })
  })

  it("forwards saves and checkpoints to the Durable Object instance that holds the rooms", async () => {
    const fetch = vi.fn(async () => new Response("forwarded"))
    const idFromName = vi.fn((name: string) => ({ name }))
    const handler = createRealtimeHandler(registryOf(liveDefinition(createMemoryAdapter().adapter)) as never)
    for (const search of ["?document=save", "?history=checkpoint"]) {
      const request = new Request(`https://example.com/api/_vitehub/realtime/docs/posts/hello${search}`, { method: "POST" })
      Object.assign(request, { runtime: { cloudflare: { env: { $DurableObject: { get: () => ({ fetch }), idFromName } } } } })

      const response = await handler.fetch(request)

      await expect(response.text()).resolves.toBe("forwarded")
    }
    // Nitro's cloudflare-durable entry sends every WebSocket upgrade to the instance named "server".
    expect(idFromName.mock.calls).toEqual([["server"], ["server"]])
  })

  it("re-seeds when an explicit save conflicts", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    memory.adapter.save.mockRejectedValueOnce(new RealtimeDocumentConflict())
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()
    await pace()
    client.doc.getMap("fields").set("title", "Mine")
    const response = await server.post("page", "save", { state: Y.encodeStateAsUpdate(client.doc) })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ data: { code: "REALTIME_SOURCE_CHANGED" } })
    expect(client.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
  })
})

describe("adapter seams for live documents", () => {
  it("picks the editor codec of each document from an editor function", async () => {
    const memory = createMemoryAdapter({ "notes/a": { body: "One" }, "posts/b": { body: "Two" } })
    const notes = createStubEditor()
    const posts = createStubEditor()
    const pick = vi.fn(({ documentId }: { documentId: string }) => documentId.startsWith("notes/") ? notes.editor : posts.editor)
    const server = createTestServer({ document: memory.adapter, editor: pick })
    const first = await server.connect("notes/a")
    const second = await server.connect("posts/b")
    await settle()

    expect(paragraphs(first.doc)).toEqual(["One"])
    expect(paragraphs(second.doc)).toEqual(["Two"])
    expect(notes.calls.fromMarkdown).toBe(1)
    expect(posts.calls.fromMarkdown).toBe(1)
    expect(pick).toHaveBeenCalledWith({ authority: "memory", definition: "docs", documentId: "notes/a" })
    first.close()
    second.close()
  })

  it("holds a writable room while clients stay, then saves and releases after the last one leaves", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const hold = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const adapter = Object.assign(memory.adapter, { hold, release })
    const server = createTestServer(liveDefinition(adapter, {
      identify: ({ request }) => {
        const id = request.headers.get("x-user")
        return id ? { id, name: id.toUpperCase() } : null
      },
      authorize: ({ mode, user }) => mode === "read" || user?.id !== "viewer",
    }))

    const ana = await server.connect("page", { headers: { "x-user": "ana" } })
    await settle()
    expect(hold).toHaveBeenLastCalledWith({ authority: "memory", definition: "docs", documentId: "page" }, { users: [{ id: "ana", name: "ANA" }] })
    const viewer = await server.connect("page", { headers: { "x-user": "viewer" } })
    const ben = await server.connect("page", { headers: { "x-user": "ben" } })
    await settle()
    // A read-only client does not hold the room.
    expect(hold).toHaveBeenLastCalledWith(expect.anything(), { users: [{ id: "ana", name: "ANA" }, { id: "ben", name: "BEN" }] })
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(hold).toHaveBeenCalledTimes(3)

    await pace()
    appendParagraph(ben.doc, "Ben")
    ana.close()
    await settle()
    expect(hold).toHaveBeenLastCalledWith(expect.anything(), { users: [{ id: "ben", name: "BEN" }] })
    expect(release).not.toHaveBeenCalled()
    ben.close()
    await settle()
    // The last writer leaving saves the room first, then releases it.
    expect(memory.store.get("page")!.body).toBe("Start\n\nBen")
    expect(release).toHaveBeenCalledOnce()
    expect(memory.adapter.save.mock.invocationCallOrder[0]!).toBeLessThan(release.mock.invocationCallOrder[0]!)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(hold).toHaveBeenCalledTimes(4)
    viewer.close()
  })

  it("shows a failed hold in the room status until a later hold succeeds", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const hold = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("Ana is editing this page alone.")).mockResolvedValue(undefined)
    const server = createTestServer(liveDefinition(Object.assign(memory.adapter, { hold })))
    const client = await server.connect("page")
    await settle()
    expect(readRealtimeStatus(client.doc).error).toBe("Ana is editing this page alone.")
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(readRealtimeStatus(client.doc).error).toBeNull()
    client.close()
  })

  it("never holds a room that the codec opened read-only", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const hold = vi.fn(async () => {})
    const editor = { ...createStubEditor().editor, verify: () => ({ writable: false }) }
    const server = createTestServer({ document: Object.assign(memory.adapter, { hold }), editor })
    const client = await server.connect("page")
    await settle()
    expect(client.controls[0]).toMatchObject({ type: "session", access: "read", reason: "document" })
    expect(hold).not.toHaveBeenCalled()
    client.close()
  })

  it("refreshes an open clean room from the server and leaves a dirty one to its next save", async () => {
    // Rooms of earlier tests stay registered in this process.
    Reflect.get(globalThis, Symbol.for("vitehub.realtime.local-refresh"))?.clear()
    const memory = createMemoryAdapter({ page: { body: "Original" } })
    const server = createTestServer(liveDefinition(memory.adapter))
    const client = await server.connect("page")
    await settle()

    await expect(refreshRealtimeDocument("docs", "missing")).resolves.toBe(false)
    await expect(refreshRealtimeDocument("docs", "page")).resolves.toBe(false)
    memory.write("page", "Agent")
    await expect(refreshRealtimeDocument("docs", "page")).resolves.toBe(true)
    expect(client.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })

    const fresh = await server.connect("page")
    await settle()
    expect(paragraphs(fresh.doc)).toEqual(["Agent"])
    await pace()
    appendParagraph(fresh.doc, "Unsaved")
    memory.write("page", "Agent again")
    await expect(refreshRealtimeDocument("docs", "page")).resolves.toBe(false)
    expect(fresh.closed).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    // The save conflicts with the outside write, which wins and re-seeds the room.
    expect(fresh.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    expect(memory.store.get("page")!.body).toBe("Agent again")
  })

  it("asks the Durable Object of a document to refresh, and strips the internal header from client requests", async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ reseeded: true }))
    const idFromName = vi.fn((name: string) => ({ name }))
    await expect(refreshRealtimeDocument("content", "posts/2026/hello", { durableObjects: { get: () => ({ fetch }), idFromName } })).resolves.toBe(true)
    expect(idFromName).toHaveBeenCalledWith("server")
    const sent = fetch.mock.calls[0]![0]
    expect(sent.method).toBe("POST")
    expect(new URL(sent.url).pathname).toBe("/api/_vitehub/realtime/content/posts/2026/hello")
    expect(sent.headers.get("x-vitehub-realtime-refresh")).toBe("1")

    const forward = vi.fn(async (_request: Request) => new Response("forwarded"))
    const handler = createRealtimeHandler(registryOf(liveDefinition(createMemoryAdapter().adapter)) as never)
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page?document=refresh", { method: "POST", headers: { "x-vitehub-realtime-refresh": "1" } })
    Object.assign(request, { runtime: { cloudflare: { env: { $DurableObject: { get: () => ({ fetch: forward }), idFromName } } } } })
    await handler.fetch(request)
    expect(forward.mock.calls[0]![0].headers.has("x-vitehub-realtime-refresh")).toBe(false)
  })

  it("refreshes inside the Durable Object without identity, only for a room it has open", async () => {
    const memory = createMemoryAdapter({ page: { body: "Original" } })
    const sql = new FakeSql()
    const server = createTestServer(liveDefinition(memory.adapter, { auth: true, identify: () => null }), { durable: sql })
    const internal = (path: string) => {
      const request = new Request(`https://vitehub.internal/api/_vitehub/realtime/docs/${path}?document=refresh`, { method: "POST", headers: { "x-vitehub-realtime-refresh": "1" } })
      Object.assign(request, { runtime: { cloudflare: { context: { storage: { sql } } } } })
      return server.handler.fetch(request)
    }
    await expect((await internal("page")).json()).resolves.toEqual({ reseeded: false })
    expect(memory.adapter.load).not.toHaveBeenCalled()
  })
})
