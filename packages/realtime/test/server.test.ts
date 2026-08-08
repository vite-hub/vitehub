import { afterEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { bindAwarenessIdentity, checkpointRealtimeDocument, claimAwarenessClientIds, markdownToYDoc, yDocToMarkdown } from "../src/server.ts"
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

  it("writes the live document before checkpointing Workspace history", async () => {
    const calls: string[] = []
    const document = markdownToYDoc("# Shared draft")
    const checkpoint = { createdAt: new Date(0).toISOString(), entries: {}, id: "checkpoint" }
    const workspace = {
      fs: {
        async writeFile(path: string, content: string, options: { ifDigest: string }) {
          calls.push(`write:${path}:${content}:${options.ifDigest}`)
        },
      },
      history: {
        async checkpoint(options?: { message?: string }) {
          calls.push(`checkpoint:${options?.message}`)
          return checkpoint
        },
      },
    }

    await expect(checkpointRealtimeDocument(workspace as never, "docs/page.md", document, "docs: save page", "baseline"))
      .resolves.toBe(checkpoint)
    expect(calls).toEqual([
      "write:docs/page.md:# Shared draft:baseline",
      "checkpoint:docs: save page",
    ])
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
