import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { applyRealtimeAwarenessUpdate, applyRealtimeSyncMessage, bindAwarenessIdentity, claimAwarenessClientIds, compactRealtimeAwareness, createRealtimeHandler, encodeAwarenessState, encodeSyncStep1, encodeSyncUpdate, markdownToYDoc, matchesRealtimeState, readRealtimeCheckpointState, readRealtimeWorkspaceDocument, realtimeRoomKey, replaceRealtimeDocument, restoreRealtimeDocument, writeRealtimeDocument, yDocToMarkdown } from "../src/server.ts"
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

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  serverMocks.assertAuthOrigin.mockReset().mockResolvedValue({ api: { getSession: serverMocks.getSession } })
  serverMocks.getSession.mockReset()
  serverMocks.invalidateWorkspaceStore.mockReset().mockResolvedValue(undefined)
  serverMocks.resolveWorkspaceStoreTarget.mockReset().mockResolvedValue(undefined)
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
  it("rejects malformed encoded room paths", async () => {
    const handler = createRealtimeHandler(realtimeRegistry())

    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/%E0%A4%A", {
      headers: { upgrade: "websocket" },
    }))

    expect(response.status).toBe(400)
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

  it("closes peers that send truncated realtime frames", async () => {
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const response = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }

    expect(() => response.crossws.message(peer, { uint8Array: () => new Uint8Array() })).not.toThrow()
    expect(peer.close).toHaveBeenLastCalledWith(4400, "Invalid realtime message.")

    expect(() => response.crossws.message(peer, { uint8Array: () => new Uint8Array([messageAwareness]) })).not.toThrow()
    expect(peer.close).toHaveBeenLastCalledWith(4400, "Invalid awareness update.")
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

  it("refreshes the written baseline before retrying a failed checkpoint", async () => {
    let digest = "baseline"
    let snapshots = 0
    const writeFile = vi.fn(async (_path: string, _content: string, options: { ifDigest: string | null }) => {
      if (options.ifDigest !== digest) throw new Error(`stale digest: ${options.ifDigest}`)
      digest = `written-${writeFile.mock.calls.length}`
      return "page.md"
    })
    const workspace = {
      capabilities: vi.fn().mockResolvedValue({ conditionalWrites: true }),
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn().mockResolvedValue(""),
        stat: vi.fn(async () => ({ digest })),
        writeFile,
      },
      history: {
        checkpoint: vi.fn(async () => {
          snapshots++
          if (snapshots === 1) throw new Error("publisher unavailable")
          return { entries: { "page.md": { digest } }, id: "snapshot" }
        }),
      },
    }
    serverMocks.useWorkspace.mockReturnValue(workspace)
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const websocket = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = {
      close: vi.fn(),
      publish: vi.fn(),
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    }
    websocket.crossws.open(peer)
    const client = new Y.Doc()
    peer.send.mockClear()
    websocket.crossws.message(peer, { uint8Array: () => encodeSyncStep1(client) })
    applyRealtimeSyncMessage(peer.send.mock.calls[0]![0], client, "server")
    const firstState = Y.encodeStateAsUpdate(client)

    const first = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      body: Uint8Array.from(firstState).buffer,
      method: "POST",
    }))
    expect(first.status).toBe(500)

    const update = replaceRealtimeDocument(client, "# New draft")
    websocket.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(update) })
    const second = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(client)).buffer,
      method: "POST",
    }))

    expect(second.status).toBe(200)
    expect(writeFile).toHaveBeenCalledTimes(2)
    client.destroy()
  })

  it("refreshes the baseline when a post-write failure follows a committed write", async () => {
    serverMocks.resolveWorkspaceStoreTarget.mockResolvedValue({ provider: "memory" })
    let digest = "baseline"
    const writeFile = vi.fn(async (_path: string, _content: string, options: { ifDigest: string | null }) => {
      if (options.ifDigest !== digest) throw new Error(`stale digest: ${options.ifDigest}`)
      digest = `written-${writeFile.mock.calls.length}`
      if (writeFile.mock.calls.length === 1) throw new Error("write:after failed")
      return "page.md"
    })
    const workspace = {
      capabilities: vi.fn().mockResolvedValue({ conditionalWrites: true }),
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        readFile: vi.fn().mockResolvedValue(""),
        stat: vi.fn(async () => ({ digest })),
        writeFile,
      },
      history: {
        checkpoint: vi.fn(async () => ({ entries: { "page.md": { digest } }, id: "snapshot" })),
      },
    }
    serverMocks.useWorkspace.mockReturnValue(workspace)
    const handler = createRealtimeHandler(realtimeRegistry({ checkpoint: true }))
    const websocket = await handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page.md", {
      headers: { upgrade: "websocket" },
    })) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    const document = new Y.Doc()
    websocket.crossws.open(peer)
    websocket.crossws.message(peer, { uint8Array: () => encodeSyncStep1(document) })
    applyRealtimeSyncMessage(peer.send.mock.calls.at(-1)![0], document, "server")
    const request = () => new Request("https://example.com/api/_vitehub/realtime/docs/page.md?history=checkpoint", {
      body: Uint8Array.from(Y.encodeStateAsUpdate(document)).buffer,
      method: "POST",
    })

    expect((await handler.fetch(request())).status).toBe(500)
    expect((await handler.fetch(request())).status).toBe(200)
    expect(writeFile.mock.calls.map(call => call[2]?.ifDigest)).toEqual(["baseline", "written-1"])
    expect(serverMocks.invalidateWorkspaceStore).not.toHaveBeenCalled()
    document.destroy()
  })

  it("replaces durable room state when the Workspace baseline changed", async () => {
    const stale = markdownToYDoc("# Stale document")
    const exec = vi.fn((query: string) => ({
      toArray: () => query.startsWith("SELECT baseline_digest")
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

    const response = await handler.fetch(request as never) as Response & { crossws: { message(peer: object, message: object): void, open(peer: object): void } }

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR REPLACE"),
      realtimeRoomKey("docs", "page.md"),
      "current",
      expect.any(ArrayBuffer),
    )
    expect(exec).not.toHaveBeenCalledWith(expect.stringContaining("SELECT update_blob"), expect.anything())
    exec.mockClear()
    const peer = { close: vi.fn(), publish: vi.fn(), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }
    response.crossws.open(peer)
    const updateDocument = new Y.Doc()
    updateDocument.getMap("edits").set("value", true)
    response.crossws.message(peer, { uint8Array: () => encodeSyncUpdate(Y.encodeStateAsUpdate(updateDocument)) })

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO vitehub_realtime_updates"),
      realtimeRoomKey("docs", "page.md"),
      expect.any(ArrayBuffer),
    )
    expect(exec).not.toHaveBeenCalledWith(expect.stringContaining("INSERT OR REPLACE"), expect.anything(), expect.anything(), expect.anything())
    updateDocument.destroy()
    stale.destroy()
  })

  it("does not persist durable rooms for missing Workspace documents", async () => {
    const exec = vi.fn(() => ({ toArray: () => [] }))
    serverMocks.useWorkspace.mockReturnValue(workspaceFacade({
      exists: vi.fn().mockResolvedValue(false),
      readFile: vi.fn(),
      stat: vi.fn().mockResolvedValue(undefined),
    }))
    const handler = createRealtimeHandler(realtimeRegistry())
    const request = new Request("https://example.com/api/_vitehub/realtime/docs/missing.md", {
      headers: { upgrade: "websocket" },
    }) as Request & { runtime?: unknown }
    request.runtime = { cloudflare: { context: { storage: { sql: { exec } } } } }

    const response = await handler.fetch(request as never)

    expect(response.status).toBe(404)
    expect(exec).not.toHaveBeenCalled()
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

})

describe("realtime transport boundaries", () => {
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

    await expect(readRealtimeCheckpointState(request, 4)).rejects.toMatchObject({ statusCode: 413 })
    expect(pulls).toBeLessThanOrEqual(2)
  })

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

  it("answers read-only sync frames without applying the room state quota", () => {
    const document = markdownToYDoc("# Shared draft")
    const client = new Y.Doc()

    expect(applyRealtimeSyncMessage(encodeSyncStep1(client), document, "peer", 0)).toBeDefined()

    client.destroy()
    document.destroy()
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
