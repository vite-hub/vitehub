import { describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import * as encoding from "lib0/encoding"
import * as Y from "yjs"

import type { RealtimeDocumentDefinition, RealtimeDocumentAdapter, RealtimeDocumentContext, RealtimeDocumentSnapshot, RealtimeSaveOptions } from "../src/types.ts"
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

function definition(adapter: RealtimeDocumentDefinition["document"]): RealtimeDocumentDefinition {
  return { access: "public", document: adapter, editor: createStubEditor().editor }
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
  it("repairs a missed reset without persistence or a later save", async () => {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const [busA, busB] = [network.bus(), network.bus()]
    const [a, b] = [busA, busB].map(bus => createTestServer({ ...definition(memory.adapter), persistence: false }, { handler: { bus: () => bus } }))
    const onA = await a!.connect("page")
    const onB = await b!.connect("page")
    await flush()
    const publish = busA.publish.bind(busA)
    vi.spyOn(busA, "publish").mockImplementation(message => message.type === "reset" ? Promise.resolve() : publish(message))
    memory.write("page", "External")
    expect((await a!.post("page", "refresh")).status).toBe(200)
    await flush()
    expect(onA.closed?.code).toBe(4409)
    const fresh = await a!.connect("page")
    await flush()
    appendParagraph(fresh.doc, "New epoch edit")
    appendParagraph(onB.doc, "Old epoch edit")
    await flush(20_000)
    expect(onB.closed?.code).toBe(4409)
    const recovered = await b!.connect("page")
    await flush()
    expect(paragraphs(recovered.doc)).toEqual(["External", "New epoch edit"])
    expect(memory.adapter.save).not.toHaveBeenCalled()
  })

  it.each([false, true])("follows a missed reset after the other instance stops (read-only: %s)", async (readOnly) => {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const busA = network.bus()
    const a = createTestServer({ ...definition(memory.adapter), persistence: false }, { handler: { bus: () => busA } })
    const b = createTestServer({ authorize: ({ mode }) => !readOnly || mode === "read", document: memory.adapter, editor: createStubEditor().editor, persistence: false }, { handler: { bus: () => network.bus() } })
    await a.connect("page")
    const stale = await b.connect("page")
    await flush()
    const publish = busA.publish.bind(busA)
    vi.spyOn(busA, "publish").mockImplementation(message => message.type === "reset" ? Promise.resolve() : publish(message))
    memory.write("page", "External")
    expect((await a.post("page", "refresh")).status).toBe(200)
    await busA.close()
    await flush(20_000)
    expect(stale.closed?.code).toBe(4409)
    const fresh = await b.connect("page")
    await flush()
    expect(paragraphs(fresh.doc)).toEqual(["External"])
    expect(memory.adapter.save).not.toHaveBeenCalled()
  })

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

  it.each([[false, false], [true, false], [false, true], [true, true]])("repairs a lost update (later update: %s, failed publish: %s)", async (later, throws) => {
    const { a, b, busA } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    const publish = busA.publish.bind(busA)
    let lost = false
    vi.spyOn(busA, "publish").mockImplementation(async (message) => {
      if (message.type === "update" && !lost) {
        lost = true
        if (throws) throw new Error("Publish failed")
        return
      }
      await publish(message)
    })
    appendParagraph(onA.doc, "Lost")
    await flush()
    if (later) appendParagraph(onA.doc, "After")
    await flush(later ? 500 : 15_000)
    expect(paragraphs(onB.doc)).toEqual(paragraphs(onA.doc))
    appendParagraph(onB.doc, "Still writable")
    await flush()
    expect(onB.closed).toBeUndefined()
    const newcomer = await b.connect("page")
    await flush()
    expect(newcomer.closed).toBeUndefined()
    expect(paragraphs(onA.doc)).toContain("Still writable")
  })

  it("does not transfer remote awareness ownership on a stock client's echo", async () => {
    const { a, b } = twoInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    const watcher = await b.connect("page")
    await flush()
    const ada = createClientAwareness(onA)
    ada.set({ user: { name: "Ada" }, cursor: 1 })
    await flush()
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(ada.awareness, [onA.doc.clientID]))
    ;(onB.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } })
      .crossws.message(onB.peer, { uint8Array: () => encoding.toUint8Array(encoder) })
    await flush()
    ada.set({ user: { name: "Ada" }, cursor: 2 })
    await flush()
    expect(presence(watcher).get(onA.doc.clientID)).toMatchObject({ cursor: 2 })
    onA.close()
    await flush()
    expect(presence(watcher).has(onA.doc.clientID)).toBe(false)
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
    const moved = await b.connect("page", { doc: onA.doc, clientId: true })
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

  it("keeps unchanged-clock presence when a client hands off before its old socket closes", async () => {
    const { a, b, memory, network } = twoInstances()
    const c = createTestServer(definition(memory.adapter), { handler: { bus: () => network.bus() } })
    const onC = await c.connect("page")
    const onA = await a.connect("page", { clientId: true })
    const watcher = await b.connect("page")
    await flush()
    const ada = createClientAwareness(onA)
    ada.set({ user: { name: "Ada" }, cursor: 1 })
    await flush()
    const moved = await b.connect("page", { doc: onA.doc, clientId: true })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(ada.awareness, [onA.doc.clientID]))
    ;(moved.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } })
      .crossws.message(moved.peer, { uint8Array: () => encoding.toUint8Array(encoder) })
    await flush()
    onA.close()
    await flush()
    expect(presence(watcher).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" }, cursor: 1 })
    expect(presence(onC).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" }, cursor: 1 })
    moved.close()
    await flush()
    expect(presence(watcher).has(onA.doc.clientID)).toBe(false)
    expect(presence(onC).has(onA.doc.clientID)).toBe(false)
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

/**
 * An adapter of one instance over a shared store, which a test can hold: a save waits before it writes, a load reads the
 * store at once and returns when released, and a crashed instance can no longer save.
 */
function controllable(adapter: RealtimeDocumentAdapter) {
  let saveGate: Promise<void> | undefined
  let loadGate: Promise<void> | undefined
  let crashed = false
  const hold = () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { gate, release }
  }
  return {
    adapter: {
      kind: "controllable",
      async load(context: RealtimeDocumentContext) {
        const loaded = await adapter.load(context)
        await loadGate
        return loaded
      },
      async save(context: RealtimeDocumentContext, document: RealtimeDocumentSnapshot, options: RealtimeSaveOptions) {
        await saveGate
        if (crashed) throw new Error("This instance stopped.")
        return await adapter.save(context, document, options)
      },
    } satisfies RealtimeDocumentAdapter,
    crash() {
      crashed = true
    },
    holdLoad() {
      const { gate, release } = hold()
      loadGate = gate
      return () => {
        loadGate = undefined
        release()
      }
    },
    holdSave() {
      const { gate, release } = hold()
      saveGate = gate
      return () => {
        saveGate = undefined
        release()
      }
    },
  }
}

describe("saves across instances", () => {
  it("adopts a no-op save's deletion after the saving room closes", async () => {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const busA = network.bus()
    const [a, b] = [busA, network.bus()].map(bus => createTestServer({ ...definition(memory.adapter), persistence: false }, { handler: { bus: () => bus } }))
    const onA = await a!.connect("page")
    const onB = await b!.connect("page")
    await flush()
    appendParagraph(onA.doc, "Undone")
    await flush()
    const publish = busA.publish.bind(busA)
    vi.spyOn(busA, "publish").mockImplementation(message => message.type === "update" ? Promise.resolve() : publish(message))
    onA.doc.getXmlFragment("body").delete(1, 1)
    await flush()
    expect((await a!.post("page", "save", { state: Y.encodeStateAsUpdate(onA.doc) })).status).toBe(200)
    onA.close()
    await flush()
    expect((await b!.post("page", "save", { state: Y.encodeStateAsUpdate(onB.doc) })).status).toBe(200)
    expect(memory.store.get("page")).toMatchObject({ body: "Start", digest: "v1" })
    expect(memory.adapter.save).not.toHaveBeenCalled()
    expect(paragraphs(onB.doc)).toEqual(["Start"])
  })

  it.each([false, true])("restores the current status digest for a clean checkpoint (interrupted: %s)", async (interrupted) => {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const checkpoint = vi.fn(async (_context: RealtimeDocumentContext, options: { digest: string }) => {
      if (options.digest !== memory.store.get("page")!.digest) throw new Error("Stale checkpoint digest")
      return { id: "checkpoint", createdAt: new Date().toISOString(), entries: {} }
    })
    const busA = network.bus()
    const [a, b] = [busA, network.bus()].map(bus => createTestServer({
      ...definition({ ...memory.adapter, checkpoint }), history: { checkpoint: true }, persistence: false,
    }, { handler: { bus: () => bus } }))
    const onA = await a!.connect("page")
    await flush()
    if (interrupted) {
      const write = busA.writeRoom.bind(busA)
      vi.spyOn(busA, "writeRoom").mockImplementation((room, record, ifEpoch) => record.digest === "v2" ? Promise.reject(new Error("Record unavailable")) : write(room, record, ifEpoch))
    }
    appendParagraph(onA.doc, "Saved")
    await flush()
    expect((await a!.post("page", "save", { state: Y.encodeStateAsUpdate(onA.doc) })).status).toBe(interrupted ? 500 : 200)
    await busA.close()
    const onB = await b!.connect("page")
    await flush()
    const response = await b!.post("page", "checkpoint", { state: Y.encodeStateAsUpdate(onB.doc) })
    expect(response.status).toBe(200)
    expect(checkpoint).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ digest: "v2" }))
  })

  function controlledInstances(options: Parameters<typeof createMemoryAdapter>[1] = {}) {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } }, options)
    const [controlA, controlB] = [controllable(memory.adapter), controllable(memory.adapter)]
    const [busA, busB] = [network.bus(), network.bus()]
    const a = createTestServer(definition(controlA.adapter), { handler: { bus: () => busA } })
    const b = createTestServer(definition(controlB.adapter), { handler: { bus: () => busB } })
    return { a, b, busA, controlA, controlB, memory, network }
  }

  it.each([false, true])("clears an unfinished save when a retry finds that the edits cancelled out (record failure: %s)", async (recordFailure) => {
    const { a, b, busA, memory, network } = controlledInstances()
    const onA = await a.connect("page")
    await flush()
    memory.adapter.save.mockImplementationOnce(async () => { throw new Error("Store unavailable") })
    appendParagraph(onA.doc, "Deleted later")
    await flush(2_100)
    const key = realtimeRoomKey("docs", "page")
    expect(network.records.get(key)).toMatchObject({ digest: "v1", pending: true })
    const write = busA.writeRoom.bind(busA)
    let failures = 0
    vi.spyOn(busA, "writeRoom").mockImplementation(async (room, record, ifEpoch) => {
      if (recordFailure && !record.pending && failures < 3) {
        failures++
        throw new Error("Record write failed")
      }
      return await write(room, record, ifEpoch)
    })

    onA.doc.getXmlFragment("body").delete(1, 1)
    await flush(7_000)
    expect(memory.adapter.save).toHaveBeenCalledTimes(1)
    expect(memory.store.get("page")).toMatchObject({ body: "Start", digest: "v1" })
    onA.close()
    await flush()
    const onB = await b.connect("page")
    await flush(3_000)
    expect(paragraphs(onB.doc)).toEqual(["Start"])
    expect(network.records.get(key)?.pending).not.toBe(true)
    expect(memory.store.get("page")).toMatchObject({ body: "Start", digest: "v1" })
  })

  it.each(["throw", "reject"])("retries the exact normalized record before its next save: %s", async (failure) => {
    const { a, b, busA, memory, network } = controlledInstances({
      normalize: document => ({ ...document, body: document.body.replace("saved by A", "Saved by A") }),
    })
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    const key = realtimeRoomKey("docs", "page")
    const epoch = network.records.get(key)!.epoch
    const write = busA.writeRoom.bind(busA)
    let failures = 0
    vi.spyOn(busA, "writeRoom").mockImplementation(async (room, record, ifEpoch) => {
      if (record.digest === "v2" && failures < 3) {
        failures++
        if (failure === "reject") return false
        throw new Error("Record write failed")
      }
      return await write(room, record, ifEpoch)
    })
    // B's own save must give A time to retry the final record, rather than re-seeding immediately.
    appendParagraph(onA.doc, "saved by A")
    await flush(2_100)
    expect(failures).toBe(3)
    expect(memory.store.get("page")!.body).toBe("Start\n\nSaved by A")
    expect(network.records.get(key)).toMatchObject({ digest: "v1", pending: true })
    appendParagraph(onB.doc, "Typed on B")
    await flush(6_000)

    expect(memory.store.get("page")!.body).toBe("Start\n\nSaved by A\n\nTyped on B")
    expect(paragraphs(onA.doc)).toEqual(["Start", "Saved by A", "Typed on B"])
    expect(paragraphs(onB.doc)).toEqual(paragraphs(onA.doc))
    expect([...onA.controls, ...onB.controls].filter(control => control.type === "reset")).toEqual([])
    expect(network.records.get(key)).toMatchObject({ epoch, digest: memory.store.get("page")!.digest })
    expect(network.records.get(key)?.pending).not.toBe(true)
  })

  it.each(["stopped saver", "outside write"])("re-seeds an unmatched pending save after a %s", async (scenario) => {
    const { a, b, busA, controlA, memory, network } = controlledInstances({
      normalize: document => ({ ...document, body: document.body.replace("saved by A", "Saved by A") }),
    })
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    const key = realtimeRoomKey("docs", "page")
    const epoch = network.records.get(key)!.epoch
    const write = busA.writeRoom.bind(busA)
    vi.spyOn(busA, "writeRoom").mockImplementation(async (room, record, ifEpoch) => {
      if (record.digest === "v2") throw new Error("Record write failed")
      return await write(room, record, ifEpoch)
    })
    appendParagraph(onA.doc, "saved by A")
    await flush(2_100)
    if (scenario === "stopped saver") {
      busA.crash()
      controlA.crash()
    }
    else memory.write("page", "Changed outside the room")
    appendParagraph(onB.doc, "Typed on B")
    await flush(16_000)

    expect(onB.controls.at(-1)).toMatchObject({ type: "reset", reason: "source-changed" })
    expect(onB.closed).toMatchObject({ code: 4409 })
    // The reset lets a client keep its old document for manual recovery; it must not silently overwrite the store.
    expect(paragraphs(onB.doc)).toContain("Typed on B")
    const fresh = await b.connect("page")
    await flush()
    expect(paragraphs(fresh.doc)).toEqual(scenario === "stopped saver" ? ["Start", "Saved by A"] : ["Changed outside the room"])
    expect(network.records.get(key)!.epoch).not.toBe(epoch)
    expect(network.records.get(key)?.pending).not.toBe(true)
  })

  it("keeps an edit that arrived during another instance's save unsaved, so it is saved when that instance crashes", async () => {
    const { a, b, busA, controlA, memory } = controlledInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()

    const releaseSave = controlA.holdSave()
    appendParagraph(onA.doc, "Edit 1")
    await flush()
    // A's idle save takes the lock and waits in `save()`. B's save waits for the lock.
    await flush(2_000)
    appendParagraph(onA.doc, "Edit 2")
    await flush()
    expect(paragraphs(onB.doc)).toEqual(["Start", "Edit 1", "Edit 2"])

    releaseSave()
    await settle()
    // A stored edit 1 only, published the record, and stops before it saves edit 2.
    busA.crash()
    controlA.crash()
    await flush(10_000)

    expect(memory.store.get("page")!.body.split("\n\n")).toEqual(["Start", "Edit 1", "Edit 2"])
  })

  it.each(["throw", "reject", "crash", "open"])("recovers a saved document when the final record write fails: %s", async (failure) => {
    const { a, b, busA, controlA, memory, network } = controlledInstances()
    const onA = await a.connect("page")
    const onB = await b.connect("page")
    await flush()
    const epoch = network.records.get(realtimeRoomKey("docs", "page"))!.epoch
    const write = busA.writeRoom.bind(busA)
    let failed = false
    vi.spyOn(busA, "writeRoom").mockImplementation(async (key, record, ifEpoch) => {
      if (record.digest === "v2" && (!failed || failure === "crash" || failure === "open")) {
        failed = true
        if (failure === "reject") return false
        throw new Error("Record write failed")
      }
      return await write(key, record, ifEpoch)
    })
    const release = controlA.holdSave()
    appendParagraph(onA.doc, "Saved by A")
    await flush(2_100)
    appendParagraph(onB.doc, "Typed on B")
    await flush()
    release()
    await settle()
    if (failure === "crash" || failure === "open") {
      busA.crash()
      controlA.crash()
    }
    if (failure === "open") {
      const c = createTestServer(definition(memory.adapter), { handler: { bus: () => network.bus() } })
      const onC = await c.connect("page")
      await flush()
      expect(onC.closed).toBeUndefined()
      expect(paragraphs(onC.doc)).toContain("Typed on B")
    }
    await flush(10_000)
    expect(failed).toBe(true)
    expect(memory.store.get("page")!.body).toBe("Start\n\nSaved by A\n\nTyped on B")
    expect([...onA.controls, ...onB.controls].filter(control => control.type === "reset")).toEqual([])
    expect(network.records.get(realtimeRoomKey("docs", "page"))).toMatchObject({ epoch, digest: memory.store.get("page")!.digest })
  })

  it("restores an unfinished pending save when its instance stops before the adapter writes", async () => {
    const { a, b, busA, controlA, memory, network } = controlledInstances()
    const onA = await a.connect("page")
    await flush()
    const release = controlA.holdSave()
    appendParagraph(onA.doc, "Pending")
    await flush(2_100)
    const record = network.records.get(realtimeRoomKey("docs", "page"))!
    expect(record).toMatchObject({ pending: true, digest: "v1" })
    controlA.crash()
    busA.crash()
    release()
    await flush()
    const onB = await b.connect("page")
    await flush(3_000)
    expect(paragraphs(onB.doc)).toEqual(["Start", "Pending"])
    expect(onB.closed).toBeUndefined()
    expect(memory.store.get("page")!.body).toBe("Start\n\nPending")
    expect(network.records.get(realtimeRoomKey("docs", "page"))).toMatchObject({ epoch: record.epoch, digest: "v2" })
  })

  it("does not re-seed when a room opens while another instance saves", async () => {
    const { a, b, controlA, controlB, network } = controlledInstances()
    const onA = await a.connect("page")
    await flush()
    const epoch = network.records.get(realtimeRoomKey("docs", "page"))!.epoch

    const releaseSave = controlA.holdSave()
    appendParagraph(onA.doc, "Edit")
    await flush(2_100)
    // B starts to open the room while A's save holds the lock. Its load waits until the test releases it.
    const releaseLoad = controlB.holdLoad()
    const opening = b.connect("page")
    await flush()
    releaseSave()
    await flush()
    releaseLoad()
    const onB = await opening
    await flush()

    expect(onA.controls.filter(control => control.type === "reset")).toEqual([])
    expect(network.records.get(realtimeRoomKey("docs", "page"))).toMatchObject({ digest: "v2", epoch })
    expect(paragraphs(onB.doc)).toEqual(["Start", "Edit"])
  })
})

describe("refresh across instances", () => {
  it("does not replace a newer shared record with a load from before another instance's reseed and save", async () => {
    const network = createMemoryBusNetwork()
    const memory = createMemoryAdapter({ page: { body: "Start" } })
    const [controlA, controlB] = [controllable(memory.adapter), controllable(memory.adapter)]
    const a = createTestServer(definition(controlA.adapter), { handler: { bus: () => network.bus() } })
    const b = createTestServer(definition(controlB.adapter), { handler: { bus: () => network.bus() } })
    await a.connect("page")
    await b.connect("page")
    await flush()

    memory.write("page", "Written by an Agent")
    // B's refresh loads the outside version, and waits before it uses it.
    const releaseLoad = controlB.holdLoad()
    const refreshingB = b.post("page", "refresh")
    await flush()
    // Meanwhile A re-seeds from that version, and a client saves a new edit on A.
    const refreshingA = a.post("page", "refresh")
    await flush()
    const writer = await a.connect("page")
    await flush()
    appendParagraph(writer.doc, "Saved on A")
    await flush(3_000)

    releaseLoad()
    await Promise.all([refreshingA, refreshingB])
    await flush(5_000)

    // The shared record never went back to an older stored version, and it describes what the adapter stored.
    const digests = network.writes.map(write => write.digest).filter((digest, index, all) => digest !== all[index - 1])
    expect(digests).toEqual([...new Set(digests)])
    expect(network.records.get(realtimeRoomKey("docs", "page"))!.digest).toBe(memory.store.get("page")!.digest)
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
