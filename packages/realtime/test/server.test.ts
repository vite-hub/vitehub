import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { applyRealtimeAwarenessUpdate, applyRealtimeSyncMessage, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness, createRealtimeHandler, encodeSyncUpdate, markdownToYDoc, matchesRealtimeState, readRealtimeWorkspaceDocument, realtimeRoomKey, replaceRealtimeDocument, restoreRealtimeDocument, writeRealtimeDocument, yDocToMarkdown } from "../src/server.ts"
import { resolveRealtimeApplicationPath } from "../src/application-path.ts"
import { decodeWorkspaceChange, encodeWorkspaceChange, readAwarenessClientIds } from "../src/protocol.ts"

const serverMocks = vi.hoisted(() => ({
  assertAuthOrigin: vi.fn(),
  getSession: vi.fn(),
  useWorkspace: vi.fn(),
}))

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: serverMocks.assertAuthOrigin,
}))

vi.mock("@vite-hub/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vite-hub/workspace")>(),
  useWorkspace: serverMocks.useWorkspace,
}))

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  serverMocks.assertAuthOrigin.mockReset().mockResolvedValue({ api: { getSession: serverMocks.getSession } })
  serverMocks.getSession.mockReset()
  serverMocks.useWorkspace.mockReset()
})

function realtimeRegistry(options: { auth?: boolean, checkpoint?: boolean } = {}) {
  return {
    docs: async () => ({
      default: {
        auth: options.auth,
        document: { workspace: "test" },
        history: options.checkpoint ? { checkpoint: true } : undefined,
      },
    }),
  } as never
}

function workspaceFacade(fs: Record<string, unknown>, capabilities = { conditionalWrites: true }) {
  return { capabilities: vi.fn().mockResolvedValue(capabilities), fs }
}

describe("realtime server handler", () => {
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

  it("rejects checkpoints when the Workspace Store cannot write conditionally", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({}, { conditionalWrites: false }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      method: "POST",
    }))

    expect(response.status).toBe(501)
    expect(serverMocks.useWorkspace).toHaveBeenCalledTimes(1)
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
    const client = markdownToYDoc("# Unsynchronized client version")

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

  it("treats an @workspace path as a document without the events selector", async () => {
    const readFile = vi.fn().mockResolvedValue("# Workspace document")
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(true),
      readFile,
      stat: vi.fn().mockResolvedValue({ digest: "baseline" }),
      writeFile: vi.fn(),
    }))
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const client = markdownToYDoc("# Unsynchronized client version")

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

  it("replaces durable room state when the Workspace baseline changed", async () => {
    const stale = markdownToYDoc("# Stale document")
    const exec = vi.fn((query: string) => ({
      toArray: () => query.startsWith("SELECT")
        ? [{ baseline_digest: "stale", update_blob: Uint8Array.from(Y.encodeStateAsUpdate(stale)).buffer }]
        : [],
    }))
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue("# Current document"),
      stat: vi.fn().mockResolvedValue({ digest: "current" }),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context: { storage: { sql: { exec } } } } }

    await handler.fetch(request)

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR REPLACE"),
      realtimeRoomKey("docs", "page.md"),
      "current",
      expect.any(ArrayBuffer),
    )
    stale.destroy()
  })

})

describe("realtime transport boundaries", () => {
  it("rejects sync updates that exceed the cumulative room quota", () => {
    const room = new Y.Doc()
    const updateDocument = new Y.Doc()
    updateDocument.getMap("ignored").set("payload", "x".repeat(1024))
    const message = encodeSyncUpdate(Y.encodeStateAsUpdate(updateDocument))

    expect(() => applyRealtimeSyncMessage(message, room, "peer", 512)).toThrow("room quota")
    expect(room.getMap("ignored").size).toBe(0)
    room.destroy()
    updateDocument.destroy()
  })
})

describe("realtime Workspace documents", () => {
  it("opens a new path as an empty document", async () => {
    const readFile = vi.fn()
    const result = await readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(false), readFile } } as never,
      { fs: { exists: vi.fn().mockResolvedValue(false) } } as never,
      "new.md",
    )

    expect(result).toEqual({ baselineDigest: undefined, markdown: "" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("bases generated assets on the writable store", async () => {
    const result = await readRealtimeWorkspaceDocument(
      { fs: { exists: vi.fn().mockResolvedValue(true), readFile: vi.fn().mockResolvedValue("# Generated asset") } } as never,
      { fs: { exists: vi.fn().mockResolvedValue(false) } } as never,
      "generated.md",
    )

    expect(result).toEqual({ baselineDigest: undefined, markdown: "# Generated asset" })
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
  it("creates an empty shared document without a browser DOM", () => {
    expect(yDocToMarkdown(markdownToYDoc(""))).toBe("")
  })

  it("round-trips Markdown through the shared Yjs document", () => {
    const markdown = "# Shared page\n\n![Diagram](https://example.com/diagram.png)\n\n| Name | Value |\n| --- | --- |\n| One | Two |"
    const document = markdownToYDoc(markdown)
    const normalized = yDocToMarkdown(document)

    expect(normalized).toContain("# Shared page")
    expect(normalized).toContain("![Diagram](https://example.com/diagram.png)")
    expect(normalized).toContain("| One  | Two")
    expect(yDocToMarkdown(markdownToYDoc(normalized))).toBe(normalized)
  })

  it("conditionally writes the live document for a Workspace checkpoint", async () => {
    const calls: string[] = []
    const document = markdownToYDoc("# Shared draft")
    const workspace = {
      fs: {
        async writeFile(path: string, content: string, options: { ifDigest: string, preservePath: boolean }) {
          calls.push(`write:${path}:${content}:${options.ifDigest}:${options.preservePath}`)
          return path
        },
      },
    }

    await expect(writeRealtimeDocument(workspace as never, "docs/page.md", document, "baseline"))
      .resolves.toBe("docs/page.md")
    expect(calls).toEqual([
      "write:docs/page.md:# Shared draft:baseline:true",
    ])
  })

  it("reconciles Workspace transformations without losing concurrent edits", () => {
    const submitted = markdownToYDoc("# Shared draft")
    const document = new Y.Doc()
    Y.applyUpdate(document, Y.encodeStateAsUpdate(submitted))
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
    replaceRealtimeDocument(document, "# Shared draft\n\nConcurrent edit")

    const update = replaceRealtimeDocument(submitted, "# Normalized draft")
    Y.applyUpdate(document, update)
    Y.applyUpdate(client, update)

    expect(yDocToMarkdown(document)).toBe("# Normalized draft\n\nConcurrent edit")
    expect(yDocToMarkdown(client)).toBe("# Normalized draft")
  })

  it("only checkpoints a document state the server has received", () => {
    const client = markdownToYDoc("# Shared draft")
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    const state = Y.encodeStateAsUpdate(client)

    expect(matchesRealtimeState(server, state)).toBe(true)
    client.getMap("pending").set("change", true)
    expect(matchesRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(false)

    const text = client.getText("deletion")
    text.insert(0, "pending deletion")
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    text.delete(0, text.length)
    expect(Y.encodeStateVector(server)).toEqual(Y.encodeStateVector(client))
    expect(matchesRealtimeState(server, Y.encodeStateAsUpdate(client))).toBe(false)

    client.destroy()
    server.destroy()
  })

  it("restores durable Yjs identities only for the matching Workspace version", () => {
    const original = markdownToYDoc("# Shared draft")
    const stored = {
      baseline_digest: "baseline",
      update_blob: Uint8Array.from(Y.encodeStateAsUpdate(original)).buffer,
    }
    const restored = restoreRealtimeDocument("# Shared draft", "baseline", stored)
    const replaced = restoreRealtimeDocument("# Workspace replacement", "changed", stored)

    expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(original))
    expect(yDocToMarkdown(replaced)).toBe("# Workspace replacement")

    original.destroy()
    restored.destroy()
    replaced.destroy()
  })
})

describe("workspace changes", () => {
  it("round-trips typed filesystem changes and rejects malformed payloads", () => {
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path: "docs/new.md" })))
      .toEqual({ operation: "create", path: "docs/new.md" })
    expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/old.md", to: "docs/new.md" })))
      .toEqual({ operation: "move", from: "docs/old.md", to: "docs/new.md" })
    expect(decodeWorkspaceChange(new Uint8Array([4, 1, 123]))).toBeUndefined()
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
