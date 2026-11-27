import * as decoding from "lib0/decoding"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { connectRealtimeRoom } from "../src/client.ts"

afterEach(() => vi.unstubAllGlobals())

describe("prebuilt presence clients", () => {
  it("passes page context on both connections and keeps the workspace protocol parameter", () => {
    const urls: URL[] = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) { urls.push(new URL(url)) }
      close() {}
      send() {}
    })
    const room = connectRealtimeRoom("comments", "pages/home", { changes: true, params: { page: "/public", workspace: "untrusted" } })
    try {
      expect(urls).toHaveLength(2)
      expect(urls.map(url => url.searchParams.get("page"))).toEqual(["/public", "/public"])
      expect(urls[1]!.searchParams.get("workspace")).toBe("events")
    }
    finally {
      room.destroy()
    }
  })

  it.each([undefined, "/portal/"])("mounts presence and change sockets below %s", (baseURL) => {
    const urls: string[] = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) { urls.push(url) }
      close() {}
      send() {}
    })
    const room = connectRealtimeRoom("comments", "pages/home", { baseURL, changes: true })
    try {
      const prefix = baseURL === undefined ? "" : "/portal"
      expect(urls).toHaveLength(2)
      expect(urls[0]).toBe(`wss://site.test${prefix}/_vitehub/realtime/comments/pages/home?clientId=${room.clientId}`)
      expect(urls[1]).toContain(`wss://site.test${prefix}/_vitehub/realtime/comments/`)
    }
    finally {
      room.destroy()
    }
  })

  it("connects to the app's origin from another site's page", () => {
    const urls: string[] = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "preview.example" } })
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) { urls.push(url) }
      close() {}
      send() {}
    })
    const secure = connectRealtimeRoom("presence", "room", { origin: "https://app.example", params: { ticket: "t" } })
    const local = connectRealtimeRoom("presence", "room", { origin: "http://localhost:3000" })
    try {
      expect(urls[0]).toBe(`wss://app.example/_vitehub/realtime/presence/room?ticket=t&clientId=${secure.clientId}`)
      expect(urls[1]).toBe(`ws://localhost:3000/_vitehub/realtime/presence/room?clientId=${local.clientId}`)
    }
    finally {
      secure.destroy()
      local.destroy()
    }
  })

  it("removes a field from the state that peers see when it is set to null, and keeps the other fields", () => {
    const sockets: Array<{ open: () => void, sent: Uint8Array[] }> = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
    vi.stubGlobal("WebSocket", class {
      static readonly OPEN = 1
      readonly OPEN = 1
      readyState = 0
      onopen?: () => void
      sent: Uint8Array[] = []
      constructor() { sockets.push(this) }
      open() {
        this.readyState = 1
        this.onopen?.()
      }

      send(bytes: Uint8Array) { this.sent.push(bytes) }
      close() {}
    })
    const room = connectRealtimeRoom("comments", "pages/home", { identity: { id: "ana", name: "Ana" } })
    const peer = new awarenessProtocol.Awareness(new Y.Doc())
    try {
      sockets[0]!.open()
      room.setLocal("cursor", { x: 1, y: 2 })
      room.setLocal("selection", "p-3")
      room.setLocal("cursor", null)
      for (const frame of sockets[0]!.sent) {
        const decoder = decoding.createDecoder(frame)
        if (decoding.readVarUint(decoder) === 1) awarenessProtocol.applyAwarenessUpdate(peer, decoding.readVarUint8Array(decoder), "server")
      }
      const seen = peer.getStates().get(room.clientId)
      expect(seen).toMatchObject({ selection: "p-3", user: { id: "ana", name: "Ana" } })
      expect(seen).not.toHaveProperty("cursor")
      expect(room.awareness.getLocalState()).not.toHaveProperty("cursor")
    }
    finally {
      room.destroy()
      peer.doc.destroy()
    }
  })
})
