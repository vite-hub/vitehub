import { afterEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { bindAwarenessIdentity, claimAwarenessClientIds, markdownToYDoc, matchesRealtimeStateVector, realtimeRoomKey, writeRealtimeDocument, yDocToMarkdown } from "../src/server.ts"
import { resolveRealtimeApplicationPath } from "../src/application-path.ts"
import { decodeWorkspaceChange, encodeWorkspaceChange, readAwarenessClientIds } from "../src/protocol.ts"

afterEach(() => vi.unstubAllGlobals())

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

    expect(document.getXmlFragment("default").toArray().every(node => "toArray" in node)).toBe(true)
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
        async writeFile(path: string, content: string, options: { ifDigest: string }) {
          calls.push(`write:${path}:${content}:${options.ifDigest}`)
        },
      },
    }

    await expect(writeRealtimeDocument(workspace as never, "docs/page.md", document, "baseline"))
      .resolves.toBeUndefined()
    expect(calls).toEqual([
      "write:docs/page.md:# Shared draft:baseline",
    ])
  })

  it("only checkpoints a document state the server has received", () => {
    const client = markdownToYDoc("# Shared draft")
    const server = new Y.Doc()
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    const stateVector = Y.encodeStateVector(client)

    expect(matchesRealtimeStateVector(server, stateVector)).toBe(true)
    client.getMap("pending").set("change", true)
    expect(matchesRealtimeStateVector(server, Y.encodeStateVector(client))).toBe(false)

    client.destroy()
    server.destroy()
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
