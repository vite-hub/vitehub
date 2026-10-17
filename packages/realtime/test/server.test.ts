import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap"
import type { JSONContent } from "@tiptap/core"
import { marked } from "marked"
import { runInNewContext } from "node:vm"
import * as decoding from "lib0/decoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { applyRealtimeAwarenessUpdate, applyRealtimeSyncMessage, assertRealtimeRoomStateQuota, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness, containsRealtimeState, createRealtimeHandler, createRealtimeYDoc, diffRealtimeYDoc, encodeAwarenessState, encodeSyncStep1, encodeSyncUpdate, readRealtimeRequestState, readRealtimeWorkspaceDocument, readRealtimeYDoc, realtimeRoomKey, workspaceDocument } from "../src/server.ts"
import { realtimeMarkdownEditor } from "../src/editor.ts"
import { resolveRealtimeApplicationPath } from "../src/application-path.ts"
import { decodeWorkspaceChange, encodeWorkspaceChange, messageAwareness, readAwarenessClientIds } from "../src/protocol.ts"

const serverMocks = vi.hoisted(() => ({
  assertAuthOrigin: vi.fn(),
  getSession: vi.fn(),
  invalidateWorkspaceStore: vi.fn(),
  resolveWorkspaceStoreTarget: vi.fn(),
  useWorkspace: vi.fn(),
}))

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: serverMocks.assertAuthOrigin,
}))

vi.mock("@vite-hub/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vite-hub/workspace")>(),
  invalidateWorkspaceStore: serverMocks.invalidateWorkspaceStore,
  resolveWorkspaceStoreTarget: serverMocks.resolveWorkspaceStoreTarget,
  useWorkspace: serverMocks.useWorkspace,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  serverMocks.assertAuthOrigin.mockReset().mockResolvedValue({ api: { getSession: serverMocks.getSession } })
  serverMocks.getSession.mockReset()
  serverMocks.invalidateWorkspaceStore.mockReset().mockResolvedValue(undefined)
  serverMocks.resolveWorkspaceStoreTarget.mockReset().mockResolvedValue(undefined)
  serverMocks.useWorkspace.mockReset()
})

function realtimeRegistry(options: { auth?: boolean, checkpoint?: boolean, persistence?: false } = {}) {
  const definition = {
    auth: options.auth,
    document: { workspace: "test" },
    history: options.checkpoint ? { checkpoint: true } : undefined,
    persistence: options.persistence,
  }
  return {
    docs: async () => ({ default: definition }),
  } as never
}

const markdownToYDoc = (markdown: string) => createRealtimeYDoc(realtimeMarkdownEditor, { body: markdown })
const yDocToMarkdown = async (document: Y.Doc) => (await readRealtimeYDoc(realtimeMarkdownEditor, document)).body

function workspaceFacade(fs: Record<string, unknown>, capabilities = { conditionalWrites: true }) {
  return { capabilities: vi.fn().mockResolvedValue(capabilities), fs }
}

function durableRealtimeRequest(exec: (query: string, ...bindings: unknown[]) => { toArray(): Array<Record<string, unknown>> }) {
  const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
    headers: { upgrade: "websocket" },
  }) as Request & { runtime?: unknown }
  request.runtime = { cloudflare: { context: { storage: { sql: { exec } } } } }
  return request
}

describe("realtime server handler", () => {
  it("rejects malformed encoded room paths", async () => {
    const handler = createRealtimeHandler(realtimeRegistry())

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/%E0%A4%A", {
      headers: { upgrade: "websocket" },
    }))

    expect(response.status).toBe(400)
  })

  it.each(["%2e%2e%2fsecret", ".vitehub/secret", "docs%5csecret.md"])("rejects unsafe Workspace room path %s", async (path) => {
    const handler = createRealtimeHandler(realtimeRegistry())

    const response = await handler.fetch(new Request(`https://example.com/api/_vitehub/realtime/docs/${path}`, {
      headers: { upgrade: "websocket" },
    }))

    expect(response.status).toBe(400)
  })

  it("ignores inherited realtime registry entries", async () => {
    const handler = createRealtimeHandler(realtimeRegistry())

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/constructor/page.md", {
      headers: { upgrade: "websocket" },
    }))

    expect(response.status).toBe(404)
  })

  it("ignores inherited Cloudflare storage contexts", async () => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    const context = Object.create({ storage: { sql: { exec } } })
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context } }
    const handler = createRealtimeHandler(realtimeRegistry())

    const response = await handler.fetch(request) as Response & { crossws?: unknown }

    expect(response.crossws).toBeDefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it.each(["method", "getter"])("ignores fabricated inherited SQL %s", async (kind) => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    const getter = vi.fn(() => exec)
    const prototype = Object.defineProperty({}, "exec", kind === "getter" ? { get: getter } : { value: exec })
    const sql = Object.create(prototype)
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context: { storage: { sql } } } }

    const response = await createRealtimeHandler(realtimeRegistry()).fetch(request) as Response & { crossws?: unknown }

    expect(response.crossws).toBeDefined()
    expect(exec).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects an unrelated native sql accessor", async () => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    const storagePrototype = Object.create(null)
    Object.defineProperty(storagePrototype, "exec", { value: exec })
    Object.defineProperty(storagePrototype, "sql", Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")!)
    const storage = Object.create(storagePrototype)
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context: { storage } } }

    const response = await createRealtimeHandler(realtimeRegistry()).fetch(request) as Response & { crossws?: unknown }

    expect(response.crossws).toBeDefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it.each(["method", "getter"])("ignores polluted Object.prototype SQL %s", async (kind) => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    const getter = vi.fn(() => exec)
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "exec")
    Object.defineProperty(Object.prototype, "exec", {
      configurable: true,
      ...kind === "getter" ? { get: getter } : { value: exec },
    })
    try {
      serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
        exists: vi.fn().mockResolvedValue(false),
        readFile: vi.fn(),
        stat: vi.fn().mockResolvedValue(undefined),
      }))
      const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
        headers: { upgrade: "websocket" },
      }) as Request & { runtime?: unknown }
      request.runtime = { cloudflare: { context: { storage: { sql: {} } } } }

      const response = await createRealtimeHandler(realtimeRegistry()).fetch(request) as Response & { crossws?: unknown }

      expect(response.crossws).toBeDefined()
      expect(exec).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    }
    finally {
      if (previous) Object.defineProperty(Object.prototype, "exec", previous)
      else Reflect.deleteProperty(Object.prototype, "exec")
    }
  })

  it("rejects polluted inherited SQL methods on plain storage carriers", async () => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    const sql = {}
    Object.defineProperty(Object.prototype, "exec", { configurable: true, value: exec })
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context: { storage: { sql } } } }

    try {
      const response = await createRealtimeHandler(realtimeRegistry()).fetch(request) as Response & { crossws?: unknown }

      expect(response.crossws).toBeDefined()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      delete (Object.prototype as { exec?: unknown }).exec
    }
  })

  it("rejects unauthenticated definitions before opening a room", async () => {
    serverMocks.getSession.mockResolvedValue(null)
    const handler = createRealtimeHandler(realtimeRegistry({ auth: true }))

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      headers: { origin: "https://example.com" },
      method: "POST",
    }))

    expect(response.status).toBe(401)
    expect(serverMocks.useWorkspace).not.toHaveBeenCalled()
  })

  it("uses the Auth Definition trusted-origin policy", async () => {
    serverMocks.getSession.mockResolvedValue({ user: { id: "user" } })
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ auth: true }))

    await handler.fetch(new Request("https://api.example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { origin: "https://app.example.com", upgrade: "websocket" },
    }))

    expect(serverMocks.assertAuthOrigin).toHaveBeenCalledWith(expect.objectContaining({ url: "https://api.example.com/api/_vitehub/realtime/docs/page.md" }), expect.anything())
  })

  it("rejects saves when the Workspace Store cannot write conditionally", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(),
    }, { conditionalWrites: false }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const client = new Y.Doc()

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?document=save", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
      method: "POST",
    }))

    expect(response.status).toBe(501)
    client.destroy()
  })

  it("rejects durable saves backed by an ephemeral memory Workspace Store", async () => {
    serverMocks.resolveWorkspaceStoreTarget.mockResolvedValue({ provider: "memory" })
    const writeFile = vi.fn()
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
      writeFile,
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const client = new Y.Doc()
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md?document=save", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
      method: "POST",
    })
    Object.assign(request, { runtime: { cloudflare: { context: { storage: { sql: { exec: vi.fn(() => ({ toArray: () => [] })) } } } } } })

    const response = await handler.fetch(request)

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ message: "Durable realtime rooms require a durable Workspace Store." })
    expect(writeFile).not.toHaveBeenCalled()
    client.destroy()
  })

  it("rejects an unsynchronized checkpoint before writing to Workspace", async () => {
    const writeFile = vi.fn()
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue("# Workspace version"),
      stat: vi.fn().mockResolvedValue({ digest: "baseline" }),
      writeFile,
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const client = await markdownToYDoc("# Unsynchronized client version")

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
      method: "POST",
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ data: { code: "REALTIME_SYNC_PENDING" } })
    expect(writeFile).not.toHaveBeenCalled()
    client.destroy()
  })

  it("accepts workspace changes only on the workspace room", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue(""),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = {
      close: vi.fn(),
      publish: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }

    response.crossws.open(peer)
    response.crossws.message(peer, { uint8Array: () => encodeWorkspaceChange({ operation: "create", path: "new.md" }) })

    expect(peer.close).toHaveBeenCalledWith(4400, "Workspace changes require the workspace room.")
    expect(peer.publish).not.toHaveBeenCalled()
  })

  it("does not publish through an unregistered inherited peer marker", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn(),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const inheritedPublish = vi.fn()
    const peer = Object.assign(Object.create({ publish: inheritedPublish }), {
      close: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    })

    const client = new Y.Doc()
    client.getMap("default").set("value", "changed")
    const update = encodeSyncUpdate(Y.encodeStateAsUpdate(client))
    response.crossws.message(peer, { uint8Array: () => update })

    expect(inheritedPublish).not.toHaveBeenCalled()
    client.destroy()
  })

  it("publishes through an inherited publisher for a registered peer", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn(),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const inheritedPublish = vi.fn()
    const peer = Object.assign(Object.create({ publish: inheritedPublish }), {
      close: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    })

    response.crossws.open(peer)
    const client = new Y.Doc()
    client.getMap("default").set("value", "changed")
    response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(client)) })

    expect(inheritedPublish).toHaveBeenCalledOnce()
    client.destroy()
  })

  it("rate-limits workspace changes from each peer", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100)
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/%40workspace?workspace=events", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = {
      close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    }

    response.crossws.open(peer)
    for (let index = 0; index <= 100; index++) {
      response.crossws.message(peer, { uint8Array: () => encodeWorkspaceChange({ operation: "create", path: `${index}.md` }) })
    }

    expect(peer.publish).toHaveBeenCalledTimes(100)
    expect(peer.close).toHaveBeenCalledWith(4429, "Workspace change rate limit exceeded.")
  })

  it("rejects document updates in workspace event rooms", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/%40workspace?workspace=events", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { close(peer: object): void, message(peer: object, message: object): void, open(peer: object): void } }
    const peer = {
      close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    }
    const updateDocument = new Y.Doc()
    updateDocument.getMap("edits").set("value", true)

    response.crossws.open(peer)
    response.crossws.message(peer, { uint8Array: () => encodeSyncStep1(updateDocument) })
    expect(peer.close).not.toHaveBeenCalled()
    response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(updateDocument)) })

    expect(peer.close).toHaveBeenCalledWith(4400, "Document updates cannot use the workspace room.")
    response.crossws.close(peer)
    updateDocument.destroy()
  })

  it("closes peers that send truncated realtime frames", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    response.crossws.open(peer)

    expect(() => response.crossws.message(peer, { uint8Array: () => new Uint8Array() })).not.toThrow()
    expect(peer.close).toHaveBeenLastCalledWith(4400, "Invalid realtime message.")

    expect(() => response.crossws.message(peer, { uint8Array: () => new Uint8Array([messageAwareness]) })).not.toThrow()
    expect(peer.close).toHaveBeenLastCalledWith(4400, "Invalid awareness update.")
  })

  it("holds sync updates past the burst and applies them, merged, when the budget refills", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const client = new Y.Doc()
    response.crossws.open(peer)

    const edit = (key: string) => {
      const before = Y.encodeStateVector(client)
      client.getMap("edits").set(key, true)
      response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(client, before)) })
    }
    // A burst of 40 updates, such as fast typing, is applied at once.
    for (let index = 0; index < 40; index++) edit(`key-${index}`)
    const applied = peer.publish.mock.calls.length
    expect(applied).toBeGreaterThan(0)
    // Holding a key keeps sending: the next ones wait instead of closing the peer.
    for (let index = 0; index < 5; index++) edit(`held-${index}`)
    expect(peer.publish.mock.calls.length).toBe(applied)
    await new Promise(resolve => setTimeout(resolve, 80))

    expect(peer.close).not.toHaveBeenCalled()
    // The five held updates reach the room as one.
    expect(peer.publish.mock.calls.length).toBe(applied + 1)
    client.destroy()
  })

  it("closes a peer that holds back more than one message of updates", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const client = new Y.Doc()
    response.crossws.open(peer)

    const text = "x".repeat(64 * 1024)
    for (let index = 0; index < 60 && !peer.close.mock.calls.length; index++) {
      const before = Y.encodeStateVector(client)
      client.getMap("edits").set(`key-${index}`, text)
      response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(client, before)) })
    }

    expect(peer.close).toHaveBeenCalledWith(1013, "Realtime updates are arriving too quickly.")
    client.destroy()
  })

  it("accepts only the initial sync response outside the update throttle", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const server = new Y.Doc()
    const client = new Y.Doc()
    const syncStep2 = applyRealtimeSyncMessage(encodeSyncStep1(client), server, "server")!
    client.getMap("edits").set("first", true)
    response.crossws.open(peer)

    response.crossws.message(peer, { uint8Array: () => syncStep2 })
    response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(client)) })

    expect(peer.close).not.toHaveBeenCalled()
    // Later sync responses count against the update burst like any update, and wait past it.
    for (let index = 0; index < 40; index++) response.crossws.message(peer, { uint8Array: () => syncStep2 })
    expect(peer.close).not.toHaveBeenCalled()
    server.destroy()
    client.destroy()
  })

  it("treats an @workspace path as a document without the events selector", async () => {
    const readFile = vi.fn().mockResolvedValue("# Workspace document")
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(true),
      readFile,
      stat: vi.fn().mockResolvedValue({ digest: "baseline" }),
      writeFile: vi.fn(),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const client = await markdownToYDoc("# Unsynchronized client version")

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/%40workspace?history=checkpoint", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
      method: "POST",
    }))

    expect(response.status).toBe(409)
    expect(readFile).toHaveBeenCalledWith("@workspace", { encoding: "utf8" })
    client.destroy()
  })

  it("reclaims inactive memory rooms when the retained-room limit is reached", async () => {
    serverMocks.useWorkspace.mockReturnValue({
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn().mockResolvedValue("# Workspace document"),
        stat: vi.fn().mockResolvedValue({ digest: "baseline" }),
      },
    })
    const handler = createRealtimeHandler(realtimeRegistry())

    for (let index = 0; index <= 128; index++) {
      const response = await handler.fetch(new Request(`https://example.com/api/_vitehub/realtime/docs/page-${index}.md`, {
        headers: { upgrade: "websocket" },
      })) as Response & { crossws?: { close(peer: object): void, open(peer: object): void } }
      const peer = {
        close: vi.fn(),
        publish: vi.fn(),
        send: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      }

      expect(response.crossws).toBeDefined()
      response.crossws!.open(peer)
      response.crossws!.close(peer)
    }
  })

  it("does not evict inactive memory rooms with unsaved collaborative edits", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ persistence: false }))
    const updateDocument = new Y.Doc()
    updateDocument.getMap("edits").set("value", true)
    const update = encodeSyncUpdate(Y.encodeStateAsUpdate(updateDocument))

    for (let index = 0; index < 128; index++) {
      const response = await handler.fetch(new Request(`https://example.com/api/_vitehub/realtime/docs/edited-${index}.md`, {
        headers: { upgrade: "websocket" },
      })) as Response & { crossws: { close(peer: object): void, message(peer: object, message: object): void, open(peer: object): void } }
      const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
      response.crossws.open(peer)
      response.crossws.message(peer, { uint8Array: () => update })
      response.crossws.close(peer)
    }

    const overflow = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/overflow.md", {
      headers: { upgrade: "websocket" },
    }))
    expect(overflow.status).toBe(503)
    updateDocument.destroy()
  })

  it("does not evict an inactive room while it is reconnecting", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())

    for (let index = 0; index < 128; index++) {
      const response = await handler.fetch(new Request(`https://example.com/api/_vitehub/realtime/docs/page-${index}.md`, {
        headers: { upgrade: "websocket" },
      })) as Response & { crossws: { close(peer: object): void, open(peer: object): void } }
      const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
      response.crossws.open(peer)
      response.crossws.close(peer)
    }

    const [reconnecting, overflow] = await Promise.all([
      handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page-0.md", {
        headers: { upgrade: "websocket" },
      })),
      handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/overflow.md", {
        headers: { upgrade: "websocket" },
      })),
    ])

    expect((reconnecting as Response & { crossws?: unknown }).crossws).toBeDefined()
    expect(overflow.status).toBe(503)
  })

  it("does not retain rooms for rejected checkpoints", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))

    for (let index = 0; index < 129; index++) {
      const response = await handler.fetch(new Request(`https://example.com/api/_vitehub/realtime/docs/rejected-${index}.md?history=checkpoint`, {
        method: "POST",
      }))
      expect(response.status).toBe(400)
    }

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/valid.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws?: unknown }
    expect(response.crossws).toBeDefined()
  })

  it("retries room initialization after a Workspace read fails", async () => {
    const stat = vi.fn()
      .mockRejectedValueOnce(new Error("Workspace read failed"))
      .mockResolvedValue(undefined)
    const exec = vi.fn(() => ({ toArray: () => [] }))
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat,
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const request = () => durableRealtimeRequest(exec)

    expect((await handler.fetch(request())).status).toBe(500)
    const response = await handler.fetch(request()) as Response & { crossws: { close(peer: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    response.crossws.open(peer)
    response.crossws.close(peer)

    expect(stat).toHaveBeenCalledTimes(3)
  })

  it("does not retain awareness clients from a rejected update", async () => {
    serverMocks.getSession.mockResolvedValue({ user: { id: "user" } })
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ auth: true }))
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { origin: "https://example.com", upgrade: "websocket" },
    })) as Response & { crossws: { close(peer: object): void, message(peer: object, message: object): void, open(peer: object): void } }
    const firstPeer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const secondPeer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    response.crossws.open(firstPeer)
    response.crossws.open(secondPeer)
    const rejectedDocument = new Y.Doc()
    const rejected = new awarenessProtocol.Awareness(rejectedDocument)
    rejected.setLocalState(42 as never)
    const clientId = rejectedDocument.clientID
    response.crossws.message(firstPeer, {
      uint8Array: () => encodeAwarenessState(rejected, [clientId]),
    })
    expect(firstPeer.close).toHaveBeenCalledWith(4400, "Invalid awareness update.")

    const acceptedDocument = new Y.Doc()
    acceptedDocument.clientID = clientId
    const accepted = new awarenessProtocol.Awareness(acceptedDocument)
    accepted.setLocalState({ cursor: { anchor: 1 } })
    response.crossws.message(secondPeer, {
      uint8Array: () => encodeAwarenessState(accepted, [clientId]),
    })
    response.crossws.close(firstPeer)
    secondPeer.send.mockClear()
    response.crossws.message(secondPeer, { uint8Array: () => new Uint8Array([3]) })
    response.crossws.message(secondPeer, { uint8Array: () => new Uint8Array([3]) })

    expect(secondPeer.send).toHaveBeenCalledOnce()
    rejected.destroy()
    rejectedDocument.destroy()
    accepted.destroy()
    acceptedDocument.destroy()
  })

  it("applies the latest awareness update after the throttle window", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = {
      close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    }
    const senderDocument = new Y.Doc()
    const sender = new awarenessProtocol.Awareness(senderDocument)

    response.crossws.open(peer)
    sender.setLocalState({ cursor: { anchor: 1 } })
    response.crossws.message(peer, { uint8Array: () => encodeAwarenessState(sender, [senderDocument.clientID]) })
    sender.setLocalState({ cursor: { anchor: 2 } })
    response.crossws.message(peer, { uint8Array: () => encodeAwarenessState(sender, [senderDocument.clientID]) })

    expect(peer.publish).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(peer.publish).toHaveBeenCalledTimes(2))
    const receiverDocument = new Y.Doc()
    const receiver = new awarenessProtocol.Awareness(receiverDocument)
    const decoder = decoding.createDecoder(peer.publish.mock.calls[1]![1])
    expect(decoding.readVarUint(decoder)).toBe(messageAwareness)
    applyRealtimeAwarenessUpdate(receiver, decoding.readVarUint8Array(decoder), "server")
    expect(receiver.getStates().get(senderDocument.clientID)).toMatchObject({ cursor: { anchor: 2 } })
    receiver.destroy()
    receiverDocument.destroy()
    sender.destroy()
    senderDocument.destroy()
  })

})

describe("realtime transport boundaries", () => {
  it("copies ArrayBuffer checkpoint chunks from another realm", async () => {
    const body = new ReadableStream<ArrayBuffer>({
      start(controller) {
        controller.enqueue(runInNewContext("new Uint8Array([1, 2, 3]).buffer") as ArrayBuffer)
        controller.close()
      },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))
  })

  it.each(["buffer", "byteOffset", "byteLength"])("ignores a byte chunk's shadowed %s", async (key) => {
    const value = Uint8Array.of(99, 1, 2, 3, 88).subarray(1, 4)
    const shadows = { buffer: Uint8Array.of(9, 9, 9, 9, 9).buffer, byteOffset: 0, byteLength: 1 }
    Object.defineProperty(value, key, { value: shadows[key as keyof typeof shadows] })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value); controller.close() },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))
  })

  it.each(["buffer", "byteOffset", "byteLength"])("does not read a byte chunk's own %s getter", async (key) => {
    const getter = vi.fn(() => { throw new Error("shadow getter") })
    const value = Uint8Array.of(99, 1, 2, 3, 88).subarray(1, 4)
    Object.defineProperty(value, key, { get: getter })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value); controller.close() },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))
    expect(getter).not.toHaveBeenCalled()
  })

  it("uses the real byte chunk length for quotas and cancellation", async () => {
    const value = Uint8Array.of(1, 2, 3)
    Object.defineProperty(value, "byteLength", { value: 0 })
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value) },
      cancel,
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 2)).rejects.toMatchObject({ statusCode: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("copies byte views with nonzero offsets from another realm", async () => {
    const value = runInNewContext("new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4)")
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value); controller.close() },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))
  })

  it("accepts Uint8Array subclasses as checkpoint chunks", async () => {
    const value = Buffer.from([1, 2, 3])
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value); controller.close() },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))
  })

  it("uses the intrinsic width when subclasses shadow BYTES_PER_ELEMENT", async () => {
    class ShadowedBytes extends Uint8Array {}
    Object.defineProperty(ShadowedBytes.prototype, "BYTES_PER_ELEMENT", { value: 2 })
    class ShadowedWide extends Uint16Array {}
    Object.defineProperty(ShadowedWide.prototype, "BYTES_PER_ELEMENT", { value: 1 })
    const validValue = new ShadowedBytes([1, 2, 3])
    const invalidValue = new ShadowedWide(0)

    const validBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(validValue); controller.close() },
    })
    const validRequest = new Request("https://example.com", { body: validBody, duplex: "half", method: "POST" } as RequestInit)
    await expect(readRealtimeRequestState(validRequest, 4)).resolves.toEqual(Uint8Array.of(1, 2, 3))

    const invalidBody = new ReadableStream<unknown>({
      start(controller) { controller.enqueue(invalidValue); controller.close() },
    })
    const invalidRequest = new Request("https://example.com", { body: invalidBody, duplex: "half", method: "POST" } as RequestInit)
    await expect(readRealtimeRequestState(invalidRequest)).rejects.toMatchObject({ statusCode: 400 })
  })

  it("rejects spoofed and non-byte checkpoint chunks", async () => {
    const chunks = [
      { [Symbol.toStringTag]: "ArrayBuffer" },
      new Uint16Array([1, 2]),
      new Uint16Array(0),
      new Float32Array(0),
    ]
    for (const value of chunks) {
      const body = new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue(value)
          controller.close()
        },
      })
      const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

      await expect(readRealtimeRequestState(request)).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it("stops reading a streamed checkpoint body at the room quota", async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(3))
        if (pulls === 3) controller.close()
      },
    })
    const request = new Request("https://example.com", { body, duplex: "half", method: "POST" } as RequestInit)

    await expect(readRealtimeRequestState(request, 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(pulls).toBeLessThanOrEqual(2)
  })

  it("rejects sync updates that exceed the cumulative room quota", () => {
    const room = new Y.Doc()
    const updateDocument = new Y.Doc()
    updateDocument.getMap("ignored").set("payload", "x".repeat(1024))
    const message = encodeSyncUpdate(Y.encodeStateAsUpdate(updateDocument))

    expect(() => applyRealtimeSyncMessage(message, room, "peer", { maxStateBytes: 512 })).toThrow("room quota")
    expect(room.getMap("ignored").size).toBe(0)
    room.destroy()
    updateDocument.destroy()
  })

  it("rejects oversized room state during initialization", () => {
    const room = new Y.Doc()
    room.getMap("content").set("payload", "x".repeat(1024))

    expect(() => assertRealtimeRoomStateQuota(room, 512)).toThrow("room quota")
    room.destroy()
  })
})

describe("realtime Workspace documents", () => {
  it("opens a new path as an empty document", async () => {
    const readFile = vi.fn()
    const result = await readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(false), readFile } } as never,
      { fs: { stat: vi.fn().mockResolvedValue(undefined) } } as never,
      "new.md",
    )

    expect(result).toEqual({ baselineDigest: undefined, markdown: "" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("fails room initialization when the writable Workspace cannot be inspected", async () => {
    const error = new Error("GitHub workspace store requires a token.")

    await expect(readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(false), readFile: vi.fn() } } as never,
      { fs: { stat: vi.fn().mockRejectedValue(error) } } as never,
      "page.md",
    )).rejects.toBe(error)
  })

  it("bases generated assets on the writable store", async () => {
    const result = await readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(true), readFile: vi.fn().mockResolvedValue("# Generated asset") } } as never,
      { fs: { stat: vi.fn().mockResolvedValue(undefined) } } as never,
      "generated.md",
    )

    expect(result).toEqual({ baselineDigest: undefined, markdown: "# Generated asset" })
  })

  it("reads hosted documents from the writable store when readonly assets are unavailable", async () => {
    const result = await readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(false), readFile: vi.fn() } } as never,
      {
        fs: {
          readFile: vi.fn().mockResolvedValue("# Hosted document"),
          stat: vi.fn().mockResolvedValue({ digest: "hosted" }),
        },
      } as never,
      "hosted.md",
    )

    expect(result).toEqual({ baselineDigest: "hosted", markdown: "# Hosted document" })
  })

  it("retries when the Workspace digest changes during the initial read", async () => {
    const result = await readRealtimeWorkspaceDocument(
      {
        fs: {
          exists: vi.fn().mockResolvedValue(true),
          readFile: vi.fn().mockResolvedValueOnce("# Stale").mockResolvedValue("# Current"),
        },
      } as never,
      {
        fs: {
          stat: vi.fn()
            .mockResolvedValueOnce({ digest: "old" })
            .mockResolvedValue({ digest: "current" }),
        },
      } as never,
      "page.md",
    )

    expect(result).toEqual({ baselineDigest: "current", markdown: "# Current" })
  })

  it("retries when the Workspace document disappears during the initial read", async () => {
    const exists = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const readFile = vi.fn().mockRejectedValueOnce(new Error("not found"))
    const stat = vi.fn()
      .mockResolvedValueOnce({ digest: "before" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await expect(readRealtimeWorkspaceDocument(
      { fs: { exists, readFile } } as never,
      { fs: { stat } } as never,
      "deleted.md",
    )).resolves.toEqual({ baselineDigest: undefined, markdown: "" })
  })
})

describe("realtime application paths", () => {
  it("prefixes endpoints with the configured application base URL", () => {
    vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/wiki/")

    expect(resolveRealtimeApplicationPath("/api/_vitehub/realtime/docs"))
      .toBe("/wiki/api/_vitehub/realtime/docs")
  })
})

describe("tiptap-markdown documents", () => {
  it("creates an empty shared document without a browser DOM", async () => {
    expect(await yDocToMarkdown(await markdownToYDoc(""))).toBe("")
  })

  it("round-trips Markdown through the shared Yjs document", async () => {
    const markdown = "# Shared page\n\n![Diagram](https://example.com/diagram.png)\n\n| Name | Value |\n| --- | --- |\n| One | Two |"
    const normalized = await yDocToMarkdown(await markdownToYDoc(markdown))

    expect(normalized).toContain("# Shared page")
    expect(normalized).toContain("![Diagram](https://example.com/diagram.png)")
    expect(normalized).toContain("| One  | Two")
    expect(await yDocToMarkdown(await markdownToYDoc(normalized))).toBe(normalized)
  })

  it("round-trips YAML frontmatter without turning it into document headings", async () => {
    const markdown = `---\nname: docs\ndescription: Shared editing\ndisabled: true\n---\n\n# Shared page`
    const normalized = await yDocToMarkdown(await markdownToYDoc(markdown))

    expect(normalized).toBe(markdown)
    expect(await yDocToMarkdown(await markdownToYDoc(normalized))).toBe(normalized)
  })

  it("preserves frontmatter independently of its first YAML token", async () => {
    const documents = [
      "---\n---",
      "---\n---\n\n# Page",
      "---\n\n---\n\n# Page",
      "---\n# comment\nname: docs\n---\n\n# Page",
      "---\n\nname: docs\n---\n\n# Page",
      "---\n\"navigation.order\": 1\n---\n\n# Page",
      "---\n- docs\n- api\n---\n\n# Page",
    ]

    for (const markdown of documents) {
      expect(await yDocToMarkdown(await markdownToYDoc(markdown))).toBe(markdown)
    }
  })

  it("does not register frontmatter tokenizers on the shared Markdown parser", async () => {
    const extensions = marked.defaults.extensions

    for (let index = 0; index < 5; index++) {
      await yDocToMarkdown(await markdownToYDoc("---\nname: docs\n---\n\n# Page"))
    }

    expect(marked.defaults.extensions).toBe(extensions)
  })

  it("recognizes frontmatter only as the first document block", async () => {
    const leading = yXmlFragmentToProsemirrorJSON((await markdownToYDoc("---\r\nname: docs\r\n---\r\n\r\n# Page")).getXmlFragment("body"))
    const later = yXmlFragmentToProsemirrorJSON((await markdownToYDoc("# Page\n\n---\nname: section\n---")).getXmlFragment("body"))
    const nested = "> ---\n> name: quoted\n> ---"

    expect(leading.content?.map((node: JSONContent) => node.type)).toEqual(["frontmatter", "heading"])
    expect(later.content?.map((node: JSONContent) => node.type)).not.toContain("frontmatter")
    expect(await yDocToMarkdown(await markdownToYDoc(nested))).toBe(nested)
  })

  it("conditionally writes the live document through the Workspace adapter", async () => {
    const calls: unknown[][] = []
    const workspace = {
      capabilities: async () => ({ conditionalWrites: true }),
      fs: {
        exists: async () => true,
        readFile: async () => "# Shared draft",
        async stat() {
          return { digest: "written", mediaType: "text/markdown", metadata: { title: "Shared" }, type: "file" }
        },
        async writeFile(path: string, content: string, options: object) {
          calls.push([path, content, options])
          return path
        },
      },
    }
    serverMocks.useWorkspace.mockReturnValue(workspace)

    await expect(workspaceDocument("docs").save(
      { authority: "memory", definition: "docs", documentId: "docs/page.md" },
      { body: "# Shared draft", fields: {} },
      { editors: [], ifDigest: "baseline", reason: "idle" },
    )).resolves.toEqual({ digest: "written", stored: { body: "# Shared draft" } })
    expect(calls).toEqual([
      ["docs/page.md", "# Shared draft", {
        ifDigest: "baseline",
        mediaType: "text/markdown",
        metadata: { title: "Shared" },
        preservePath: true,
      }],
    ])
  })

  it("merges a normalized stored form without losing concurrent edits", async () => {
    const submitted = await markdownToYDoc("# Shared draft")
    const document = new Y.Doc()
    Y.applyUpdate(document, Y.encodeStateAsUpdate(submitted))
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
    Y.applyUpdate(document, await diffRealtimeYDoc(realtimeMarkdownEditor, document, { body: "# Shared draft\n\nConcurrent edit" }))

    const update = await diffRealtimeYDoc(realtimeMarkdownEditor, submitted, { body: "# Normalized draft" })
    Y.applyUpdate(document, update)
    Y.applyUpdate(client, update)

    expect(await yDocToMarkdown(document)).toBe("# Normalized draft\n\nConcurrent edit")
    expect(await yDocToMarkdown(client)).toBe("# Normalized draft")
  })

  it("only saves a document state the server has received", async () => {
    const client = await markdownToYDoc("# Shared draft")
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))

    expect(containsRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(true)
    client.getMap("pending").set("change", true)
    expect(containsRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(false)

    const text = client.getText("deletion")
    text.insert(0, "pending deletion")
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    text.delete(0, text.length)
    expect(Y.encodeStateVector(server)).toEqual(Y.encodeStateVector(client))
    expect(containsRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(false)

    // A room that moved ahead of the client still contains everything the client sent.
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    server.getMap("later").set("edit", true)
    expect(containsRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(true)

    client.destroy()
    server.destroy()
  })

  it("answers read-only sync frames without applying the room state quota", async () => {
    const document = await markdownToYDoc("# Shared draft")
    const client = new Y.Doc()

    expect(applyRealtimeSyncMessage(encodeSyncStep1(client), document, "peer", { maxStateBytes: 0 })).toBeDefined()

    client.destroy()
    document.destroy()
  })
})

describe("workspace changes", () => {
  it.each(["docs/.. /secret", "docs/.git /config", "docs/git~1/config", "vitehu~1/config", "docs//file.md", "docs///file.md"])("rejects unsafe or noncanonical path %s in every change field", (path) => {
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "delete", path }))).toBeUndefined()

    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: path, to: "docs/new.md" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/old.md", to: path }))).toBeUndefined()
  })

  it("round-trips typed filesystem changes and rejects malformed payloads", () => {
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/new.md" })))
      .toEqual({ operation: "create", path: "docs/new.md" })
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/old.md", to: "docs/new.md" })))
      .toEqual({ operation: "move", from: "docs/old.md", to: "docs/new.md" })
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "../secret" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: ".vitehub/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "nested/.vitehub/config" })))
      .toEqual({ operation: "create", path: "nested/.vitehub/config" })
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "nested/.VITEHUB/config" })))
      .toEqual({ operation: "create", path: "nested/.VITEHUB/config" })
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: ".VITEHUB/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: ".ViteHub/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "VITEHU~1/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.GIT/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git /config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/git~1/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git./config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.GIT /config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git::$INDEX_ALLOCATION/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git. /config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs//file" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "C:/outside/file" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "C:outside" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.. " }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/..:stream/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.:stream/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git " }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/.git:stream" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/git~1/config" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "vitehu~1/config" }))).toBeUndefined()

    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/old.md", to: "docs\\new.md" }))).toBeUndefined()
    for (const path of ["docs/.git ", "docs/git~1", "vitehu~1/config", "docs/.. /secret", "docs/.git:stream", ".VITEHUB/config"]) {
      expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path }))).toBeUndefined()
      expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: path, to: "docs/new.md" }))).toBeUndefined()
      expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/old.md", to: path }))).toBeUndefined()
    }
    expect(decodeWorkspaceChange(new Uint8Array([4, 1, 123]))).toBeUndefined()
  })

  it.each(["docs/.. ", "C:secret", "docs/.git ", "git~1", "vitehu~1/config"])("rejects Windows-equivalent unsafe path %s", (path) => {
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: path, to: "docs/safe.md" }))).toBeUndefined()
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/safe.md", to: path }))).toBeUndefined()
  })

  it("encodes definition and document room keys without delimiter collisions", () => {
    expect(realtimeRoomKey("public", "private:secret.md"))
      .not.toBe(realtimeRoomKey("public:private", "secret.md"))
  })
})

describe("realtime awareness", () => {
  it("compacts metadata for departed awareness clients", () => {
    const document = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(document)
    awareness.setLocalState(null)
    const senderDocument = new Y.Doc()
    const sender = new awarenessProtocol.Awareness(senderDocument)
    sender.setLocalState({ user: { id: "departed" } })
    awarenessProtocol.applyAwarenessUpdate(awareness, awarenessProtocol.encodeAwarenessUpdate(sender, [senderDocument.clientID]), "peer")
    awarenessProtocol.removeAwarenessStates(awareness, [senderDocument.clientID], "peer")

    const compacted = compactRealtimeAwareness(awareness)

    expect(compacted.getStates().size).toBe(0)
    expect([...compacted.meta.keys()]).toEqual([document.clientID])
    compacted.destroy()
    document.destroy()
    sender.destroy()
    senderDocument.destroy()
  })

  it("rejects updates that exceed the cumulative awareness quota", () => {
    const roomDocument = new Y.Doc()
    const room = new awarenessProtocol.Awareness(roomDocument)
    room.setLocalState(null)
    const senderDocument = new Y.Doc()
    const sender = new awarenessProtocol.Awareness(senderDocument)
    sender.setLocalState({ payload: "x".repeat(1024) })
    const update = awarenessProtocol.encodeAwarenessUpdate(sender, [senderDocument.clientID])

    expect(() => applyRealtimeAwarenessUpdate(room, update, "peer", 512)).toThrow("room quota")
    expect(room.getStates().size).toBe(0)
    room.destroy()
    roomDocument.destroy()
    sender.destroy()
    senderDocument.destroy()
  })

  it("prevents a peer from claiming another peer's client id", () => {
    const owners = new Map<number, object>()
    const firstPeer = {}
    const secondPeer = {}

    claimAwarenessClientIds(owners, firstPeer, [1])

    expect(() => claimAwarenessClientIds(owners, secondPeer, [1])).toThrow("already owned")
    expect(owners.get(1)).toBe(firstPeer)
  })

  it("limits the cumulative awareness clients owned by one peer", () => {
    const owners = new Map<number, object>()
    const peer = {}
    claimAwarenessClientIds(owners, peer, Array.from({ length: 1024 }, (_, index) => index))

    expect(() => claimAwarenessClientIds(owners, peer, [1024]))
      .toThrow("too many awareness clients")
    expect(owners.has(1024)).toBe(false)
  })

  it("reports newly claimed awareness clients for rollback", () => {
    const owners = new Map<number, object>()
    const peer = {}

    expect(claimAwarenessClientIds(owners, peer, [1, 2])).toEqual([1, 2])
    expect(claimAwarenessClientIds(owners, peer, [2, 3])).toEqual([3])
  })

  it("reads the clients represented by a Yjs awareness update", () => {
    const document = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(document)
    awareness.setLocalStateField("user", { color: "#2563EB", id: "user-1", name: "Max" })

    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [document.clientID])

    expect(readAwarenessClientIds(update)).toEqual([document.clientID])
    awareness.destroy()
    document.destroy()
  })

  it("replaces authenticated identity before broadcasting awareness", () => {
    const document = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(document)
    awareness.setLocalState({ cursor: { anchor: 1 }, user: { id: "forged", name: "Forged" } })
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [document.clientID])
    const secured = bindAwarenessIdentity(update, { color: "#2563EB", id: "user-1", name: "Maxi" })
    const receiverDocument = new Y.Doc()
    const receiver = new awarenessProtocol.Awareness(receiverDocument)
    awarenessProtocol.applyAwarenessUpdate(receiver, secured, "server")

    expect(receiver.getStates().get(document.clientID)).toEqual({
      cursor: { anchor: 1 },
      user: { color: "#2563EB", id: "user-1", name: "Maxi" },
    })
    awareness.destroy()
    document.destroy()
    receiver.destroy()
    receiverDocument.destroy()
  })
})
