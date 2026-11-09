import { describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as encoding from "lib0/encoding"
import * as Y from "yjs"

import type { RealtimeDefinition } from "../src/types.ts"
import { messageAwareness } from "../src/protocol.ts"
import { realtimeRoomKey } from "../src/server.ts"
import { appendParagraph, createClientAwareness, createMemoryAdapter, createMemoryBusNetwork, createStubEditor, createTestServer, paragraphs, presence, settle } from "./harness.ts"

import type { MemoryBus } from "./harness.ts"

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: vi.fn(async () => {
    throw new Error("Fan-out tests do not use Auth.")
  }),
}))

// One fake clock for the whole file, installed before lib0 loads: lib0 keeps the `Date.now` it finds, and Yjs
// awareness reads it to expire clients.
vi.hoisted(() => {
  vi.useFakeTimers()
})

/** Lets bus messages, adapter calls, and paced client updates run. */
async function flush(ms = 60): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await settle()
    await vi.advanceTimersByTimeAsync(ms / 5)
  }
}

function definition(adapter: RealtimeDefinition["document"]): RealtimeDefinition {
  return { document: adapter, editor: createStubEditor().editor }
}

/** Two server instances of one app that share rooms over an in-memory bus. */
function twoInstances(initial: Record<string, { body: string }> = { page: { body: "Start" } }) {
  const network = createMemoryBusNetwork()
  const memory = createMemoryAdapter(initial)
  const buses: MemoryBus[] = [network.bus(), network.bus()]
  const [a, b] = buses.map(bus => createTestServer(definition(memory.adapter), { handler: { bus: () => bus } }))
  return { a: a!, b: b!, busA: buses[0]!, busB: buses[1]!, memory, network }
}

describe("rooms shared across instances", () => {
  it("sends an edit on instance A to a client on instance B, and starts B from the same Yjs history", async () => {
    const { a, b, network } = twoInstances()
    const onA = await a.connect("page")
    await flush()
    const onB = await b.connect("page")
    await flush()

    expect(network.records.get(realtimeRoomKey("docs", "page"))).toMatchObject({ digest: "v1" })
    expect(paragraphs(onB.doc)).toEqual(["Start"])
    appendParagraph(onA.doc, "From A")
    await flush()
    expect(paragraphs(onB.doc)).toEqual(["Start", "From A"])

    appendParagraph(onB.doc, "From B")
    await flush()
    expect(paragraphs(onA.doc)).toEqual(["Start", "From A", "From B"])
    expect([...onA.controls, ...onB.controls].filter(control => control.type === "reset")).toEqual([])
    // Both instances agree on one epoch, so a client can reconnect to either one.
    expect(onA.controls[0]).toMatchObject({ type: "session" })
    expect(onB.controls[0]).toMatchObject({ type: "session", epoch: onA.controls[0]!.type === "session" ? onA.controls[0]!.epoch : undefined })
  })

  it("gives an instance that opens a room later the edits of the instances that have it open", async () => {
    const { a, b } = twoInstances()
    const onA = await a.connect("page")
    await flush()
    appendParagraph(onA.doc, "Unsaved on A")
    await flush()

    const onB = await b.connect("page")
    await flush()
    expect(paragraphs(onB.doc)).toEqual(["Start", "Unsaved on A"])
  })

  it("seeds one Yjs history when two instances open a new room at the same time", async () => {
    const { a, b } = twoInstances()
    const [onA, onB] = await Promise.all([a.connect("page"), b.connect("page")])
    await flush()
    appendParagraph(onA.doc, "A")
    await flush()
    expect(paragraphs(onB.doc)).toEqual(["Start", "A"])
    expect(paragraphs(onA.doc)).toEqual(["Start", "A"])
  })

  it("saves the edits of both instances without a conflict or a lost update", async () => {
    const { a, b, memory } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    appendParagraph(onA.doc, "A")
    appendParagraph(onB.doc, "B")
    await flush()

    // Both rooms are dirty: each saves after the 2 s debounce, one at a time under the room lock.
    await flush(3_000)
    const stored = memory.store.get("page")!
    expect(stored.body.split("\n\n").sort()).toEqual(["A", "B", "Start"])
    expect([...onA.controls, ...onB.controls].filter(control => control.type === "reset")).toEqual([])
    // The second instance took in the first save and found nothing left to write.
    expect(memory.adapter.save).toHaveBeenCalledTimes(1)

    appendParagraph(onB.doc, "After the save")
    await flush(3_000)
    expect(memory.store.get("page")!.body).toContain("After the save")
    expect([...onA.controls, ...onB.controls].filter(control => control.type === "reset")).toEqual([])
  })

  it("re-seeds every instance when the stored document changed outside the room", async () => {
    const { a, b, memory } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    memory.write("page", "Written by an Agent")
    appendParagraph(onA.doc, "Edit")
    await flush(3_000)

    expect(onA.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    expect(onB.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    const [resetA, resetB] = [onA.controls.at(-1), onB.controls.at(-1)]
    expect(resetA?.type === "reset" && resetB?.type === "reset" && resetA.epoch === resetB.epoch).toBe(true)

    const again = await b.connect("page", { epoch: resetA?.type === "reset" ? resetA.epoch : undefined })
    await flush()
    expect(paragraphs(again.doc)).toEqual(["Written by an Agent"])
  })

  it("shares presence, and removes it on the other instance when an instance stops", async () => {
    const { a, b, busA } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()

    createClientAwareness(onA).set({ user: { name: "Ada" } })
    await flush()
    expect(presence(onB).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" } })

    // A client on B that opens later sees A's client too.
    const late = await b.connect("page")
    await flush()
    expect(presence(late).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" } })

    await busA.close()
    await flush()
    expect(presence(onB).has(onA.doc.clientID)).toBe(false)
  })

  it("expires the presence of an instance that stopped without a goodbye", async () => {
    const { a, b, busA } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    createClientAwareness(onA).set({ user: { name: "Ada" } })
    await flush()
    expect(presence(onB).has(onA.doc.clientID)).toBe(true)

    busA.crash()
    // Yjs awareness drops a client 30 s after its last update.
    await flush(35_000)
    expect(presence(onB).has(onA.doc.clientID)).toBe(false)
  })

  it("removes presence on the other instance when a peer leaves", async () => {
    const { a, b } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    createClientAwareness(onA).set({ user: { name: "Ada" } })
    await flush()
    onA.close()
    await flush()
    expect(presence(onB).has(onA.doc.clientID)).toBe(false)
  })

  it("lets a client that moved to another instance keep its presence", async () => {
    const { a, b } = twoInstances()
    const onA = await a.connect("page")
    const watcher = await b.connect("page")
    await flush()
    createClientAwareness(onA).set({ user: { name: "Ada" } })
    await flush()

    // The same Yjs client reconnects to B while A still lists it.
    const moved = await b.connect("page", { doc: onA.doc })
    await flush()
    const awareness = new awarenessProtocol.Awareness(onA.doc)
    awareness.setLocalState({ user: { name: "Ada" } })
    awareness.setLocalState({ user: { name: "Ada", moved: true } })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [onA.doc.clientID]))
    ;(moved.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } })
      .crossws.message(moved.peer, { uint8Array: () => encoding.toUint8Array(encoder) })
    awareness.destroy()
    await flush()
    expect(moved.closed).toBeUndefined()
    expect(presence(watcher).get(onA.doc.clientID)).toEqual({ user: { name: "Ada", moved: true } })
  })

  it("ignores updates from another Yjs history", async () => {
    const { a, b, busA } = twoInstances()
    const onB = await b.connect("page")
    await flush()
    const foreign = new Y.Doc()
    foreign.getXmlFragment("body").push([new Y.XmlElement("paragraph")])
    await busA.publish({ type: "update", room: realtimeRoomKey("docs", "page"), epoch: "another-epoch", data: Y.encodeStateAsUpdate(foreign) })
    await flush()
    expect(paragraphs(onB.doc)).toEqual(["Start"])
    void a
  })
})

describe("awareness clocks", () => {
  it("does not throw on a client's first awareness update, or when that client leaves", async () => {
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const server = createTestServer(definition(memory.adapter))
    const client = await server.connect("page")
    const other = await server.connect("page")
    await flush()

    // A new y-websocket client sends its initial `{}` state with clock 0, which Yjs does not apply.
    const awareness = new awarenessProtocol.Awareness(client.doc)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [client.doc.clientID]))
    const hooks = (client.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } }).crossws
    expect(() => hooks.message(client.peer, { uint8Array: () => encoding.toUint8Array(encoder) })).not.toThrow()
    awareness.destroy()
    expect(client.closed).toBeUndefined()

    expect(() => client.close()).not.toThrow()
    await flush()
    expect(other.closed).toBeUndefined()
  })
})
