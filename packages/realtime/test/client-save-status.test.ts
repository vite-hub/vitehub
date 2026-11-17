import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { connectRealtimeRoom } from "../src/client.ts"
import { createRealtimeHandler, refreshRealtimeDocument } from "../src/server.ts"
import { createMemoryAdapter, createStubEditor, registryOf } from "./harness.ts"

import type { RealtimeDefinition } from "../src/types.ts"

afterEach(() => vi.unstubAllGlobals())

type Hooks = {
  close(peer: object): void
  message(peer: object, message: { uint8Array(): Uint8Array }): Promise<void> | void
  open(peer: object): Promise<void> | void
  upgrade?(request: Request): unknown
}

/** A WebSocket class that sends each socket of y-websocket to the Realtime handler through its crossws hooks. */
function socketsTo(definition: RealtimeDefinition) {
  const handler = createRealtimeHandler(registryOf(definition) as never)
  const channels = new Map<string, Set<{ send(data: Uint8Array): void }>>()
  return class BridgeSocket {
    static readonly OPEN = 1
    readonly OPEN = 1
    binaryType = "arraybuffer"
    readyState = 0
    onclose?: (event: { code: number, reason: string }) => void
    onerror?: (event: unknown) => void
    onmessage?: (event: { data: ArrayBuffer }) => void
    onopen?: () => void
    private hooks?: Hooks
    private readonly peer = {
      id: crypto.randomUUID(),
      close: (code: number, reason: string) => this.closed(code, reason),
      publish: (channel: string, data: Uint8Array) => {
        for (const other of channels.get(channel) ?? []) {
          if (other !== this.peer) other.send(data)
        }
      },
      send: (data: Uint8Array) => {
        if (this.readyState === 1) this.onmessage?.({ data: Uint8Array.from(data).buffer })
      },
      subscribe: (channel: string) => {
        let set = channels.get(channel)
        if (!set) channels.set(channel, set = new Set())
        set.add(this.peer)
      },
      unsubscribe: (channel: string) => channels.get(channel)?.delete(this.peer),
    }

    constructor(url: string) {
      void this.open(url)
    }

    private async open(url: string) {
      const response = await handler.fetch(new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } })) as Response & { crossws?: Hooks }
      const hooks = response.crossws
      if (!hooks || await hooks.upgrade?.(new Request("https://example.com", { headers: { upgrade: "websocket" } })) instanceof Response) {
        this.closed(1008, "rejected")
        return
      }
      this.hooks = hooks
      await hooks.open(this.peer)
      this.readyState = 1
      this.onopen?.()
    }

    private closed(code: number, reason: string) {
      if (this.readyState === 3) return
      this.readyState = 3
      for (const set of channels.values()) set.delete(this.peer)
      this.onclose?.({ code, reason })
    }

    send(data: ArrayBuffer | Uint8Array) {
      if (this.readyState !== 1) return
      void this.hooks?.message(this.peer, { uint8Array: () => new Uint8Array(data) })
    }

    close() {
      this.hooks?.close(this.peer)
      this.closed(1000, "client closed")
    }
  }
}

/** The modules that `src/client.ts` imports, followed through relative imports. */
async function importsOf(entry: string): Promise<string[]> {
  const seen = new Set<string>()
  const packages = new Set<string>()
  const visit = async (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const code = await readFile(file, "utf8")
    // Type-only imports do not reach the bundle.
    for (const [, specifier] of code.matchAll(/^import (?!type )[^"]*"([^"]+)"/gm)) {
      if (specifier!.startsWith(".")) await visit(resolve(dirname(file), specifier!))
      else packages.add(specifier!)
    }
  }
  await visit(entry)
  return [...packages]
}

describe("connectRealtimeRoom() save status", () => {
  it("imports no Tiptap or Vue module", async () => {
    const packages = await importsOf(fileURLToPath(new URL("../src/client.ts", import.meta.url)))
    expect(packages).toContain("yjs")
    expect(packages.filter(name => name.startsWith("@tiptap/") || name === "vue")).toEqual([])
  })

  it("reads the digest of the room document, and the new one after refreshRealtimeDocument()", async () => {
    const memory = createMemoryAdapter({ "drops/abc": { body: "Version 1" } })
    vi.stubGlobal("window", { location: { protocol: "http:", host: "example.com" } })
    vi.stubGlobal("WebSocket", socketsTo({ access: "public", document: memory.adapter, editor: createStubEditor().editor }))

    const room = connectRealtimeRoom("docs", "drops/abc", { identity: { id: "reader" } })
    const update = vi.fn()
    room.onUpdate(update)
    try {
      expect(room.saveStatus()).toBeUndefined()
      await vi.waitFor(() => expect(room.saveStatus()).toMatchObject({ digest: "v1", error: null, issues: [] }))

      memory.write("drops/abc", "Version 2")
      update.mockClear()
      await expect(refreshRealtimeDocument("docs", "drops/abc")).resolves.toBe(true)
      await vi.waitFor(() => expect(room.saveStatus()?.digest).toBe(memory.store.get("drops/abc")!.digest))
      expect(update).toHaveBeenCalled()
    }
    finally {
      room.destroy()
    }
  })
})
