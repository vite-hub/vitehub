import { readFile } from "node:fs/promises"

import * as encoding from "lib0/encoding"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import type * as RealtimeClient from "../src/client.ts"
import manifest from "../package.json" with { type: "json" }

afterEach(() => vi.unstubAllGlobals())

/** Imports a module from a `data:` URL, where nothing resolves a bare or relative import. */
async function importAlone(path: string): Promise<typeof RealtimeClient> {
  const code = await readFile(new URL(`../${path}`, import.meta.url), "utf8")
  return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
}

class FakeSocket {
  static readonly OPEN = 1
  static sockets: FakeSocket[] = []
  readonly OPEN = 1
  readyState = 0
  binaryType = "blob"
  onopen?: () => void
  onmessage?: (event: { data: ArrayBuffer }) => void
  onclose?: (event: { code: number, reason: string }) => void
  onerror?: () => void
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this)
  }

  send() {}
  close() {}
  open() {
    this.readyState = 1
    this.onopen?.()
  }

  receive(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer })
  }
}

describe("prebuilt browser client", () => {
  it("is one module with no imports", async () => {
    // The data: URL import is what proves it: the normal build imports yjs and y-websocket, which cannot load that way.
    await expect(importAlone(manifest.exports["./client"].default)).rejects.toThrow()
    const client = await importAlone(manifest.exports["./client/browser.js"].default)
    expect(typeof client.connectRealtimeRoom).toBe("function")
  })

  it("joins a room on another origin and sees the people in it", async () => {
    const { connectRealtimeRoom } = await importAlone(manifest.exports["./client/browser.js"].default)
    FakeSocket.sockets = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.example" } })
    vi.stubGlobal("WebSocket", FakeSocket)

    const room = connectRealtimeRoom("presence", "boards/42", { origin: "https://app.example", params: { ticket: "t" }, identity: { id: "ana", name: "Ana" } })
    const other = new awarenessProtocol.Awareness(new Y.Doc())
    try {
      const socket = FakeSocket.sockets[0]!
      expect(socket.url).toBe(`wss://app.example/api/_vitehub/realtime/presence/boards/42?ticket=t&clientId=${room.clientId}`)
      socket.open()
      expect(room.status()).toBe("connected")

      other.setLocalState({ user: { id: "ben", name: "Ben", color: "#2563EB" }, cursor: { x: 1, y: 2 } })
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 1)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(other, [other.clientID]))
      socket.receive(encoding.toUint8Array(encoder))

      expect(room.people().map(person => person.id).sort()).toEqual(["ana", "ben"])
      expect(room.states().get(other.clientID)).toMatchObject({ cursor: { x: 1, y: 2 } })
    }
    finally {
      room.destroy()
      other.doc.destroy()
    }
  })
})
