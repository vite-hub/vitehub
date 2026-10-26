import { afterEach, describe, expect, it } from "vitest"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"

import { createRealtimeAwarenessOwners } from "../src/awareness.ts"

const rooms: awarenessProtocol.Awareness[] = []

function roomAwareness() {
  const room = new awarenessProtocol.Awareness(new Y.Doc())
  room.setLocalState(null)
  rooms.push(room)
  return room
}

function update(clients: number[], state: unknown = { cursor: 1 }, clock = 1): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, clients.length)
  for (const client of clients) {
    encoding.writeVarUint(encoder, client)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
  }
  return encoding.toUint8Array(encoder)
}

function entriesUpdate(entries: Array<[number, number, string]>): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  for (const [client, clock, state] of entries) {
    encoding.writeVarUint(encoder, client)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, state)
  }
  return encoding.toUint8Array(encoder)
}

afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.destroy()
    room.doc.destroy()
  }
})

describe("realtime awareness ownership", () => {
  it.each([[1], [2, 1], [1, 2]])("rejects every truncated prefix of clients %j without changing ownership", (...clients) => {
    const frame = update(clients)
    for (let length = 0; length < frame.length; length++) {
      const owners = createRealtimeAwarenessOwners()
      const room = roomAwareness()
      const first = {}
      const second = {}
      owners.apply(room, first, update([1]))
      owners.apply(room, second, update([3]))
      const states = [...room.getStates()]

      expect(() => owners.apply(room, second, frame.slice(0, length))).toThrow()
      expect([...room.getStates()]).toEqual(states)
      expect(owners.release(second)).toEqual([3])
      expect(owners.release(first)).toEqual([1])
      expect(owners.apply(room, {}, update([2]))).toEqual([2])
    }
  })

  it("checks the input count before filtering foreign clients or decoding missing entries", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const first = {}
    const second = {}
    owners.apply(room, first, update([1]))
    const frame = update(Array.from({ length: 1025 }, () => 1))

    for (const input of [frame, frame.slice(0, 2)]) {
      expect(() => owners.apply(room, second, input)).toThrow(expect.objectContaining({ code: "REALTIME_TOO_MANY_AWARENESS_CLIENTS" }))
    }
    expect([...room.getStates()]).toEqual([[1, { cursor: 1 }]])
    expect(owners.release(second)).toEqual([])
    expect(owners.release(first)).toEqual([1])
  })

  it("preserves entry order, clocks and states while filtering foreign clients", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const first = {}
    const second = {}
    owners.apply(room, first, update([1]))
    const frame = entriesUpdate([[2, 2, '{"cursor":2}'], [1, 9, "null"], [3, 1, '{"cursor":3}'], [2, 3, '{"cursor":4}']])

    expect(owners.apply(room, second, frame)).toEqual([2, 3, 2])
    expect([...room.getStates()]).toEqual([[1, { cursor: 1 }], [2, { cursor: 4 }], [3, { cursor: 3 }]])
    expect(owners.apply(room, second, update([2], { cursor: 0 }, 2))).toEqual([2])
    expect(room.getStates().get(2)).toEqual({ cursor: 4 })
    expect(owners.release(second)).toEqual([2, 3])
    expect(owners.release(first)).toEqual([1])
  })

  it.each([undefined, { color: "#2563EB", id: "user", name: "Max" }])("rolls back a malformed later retained state with identity %j", (identity) => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    owners.apply(room, peer, update([1]))
    const frame = entriesUpdate([[1, 2, '{"cursor":2}'], [2, 1, "{}"], [3, 1, "{"]])

    expect(() => owners.apply(room, peer, frame, identity)).toThrow(SyntaxError)
    expect([...room.getStates()]).toEqual([[1, { cursor: 1 }]])
    expect(owners.apply(room, {}, update([2, 3]))).toEqual([2, 3])
    expect(owners.release(peer)).toEqual([1])
  })

  it("validates later binary entries before parsing an earlier retained JSON state", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    const frame = entriesUpdate([[1, 1, "{"], [2, 1, "{}"]]).slice(0, -1)

    expect(() => owners.apply(room, peer, frame)).toThrow("Unexpected end of array")
    expect(room.getStates().size).toBe(0)
    expect(owners.release(peer)).toEqual([])
    expect(owners.apply(room, {}, update([1, 2]))).toEqual([1, 2])
  })

  it("accepts empty frames and ignores the JSON content of foreign states", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const first = {}
    const second = {}
    owners.apply(room, first, update([1]))

    expect(owners.apply(room, second, update([]))).toEqual([])
    expect(owners.apply(room, second, entriesUpdate([[1, 2, "{"]]))).toEqual([])
    expect(owners.apply(room, second, entriesUpdate([[1, 2, "{"], [2, 1, "{}"]]))).toEqual([2])
    expect([...room.getStates()]).toEqual([[1, { cursor: 1 }], [2, {}]])
    expect(owners.release(second)).toEqual([2])
    expect(owners.release(first)).toEqual([1])
  })

  it("keeps a peer's accumulated clients and releases them together", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    owners.apply(room, peer, update([1, 2]))
    owners.apply(room, peer, update([2, 3], { cursor: 2 }, 2))

    expect(owners.release(peer)).toEqual([1, 2, 3])
    expect(owners.release(peer)).toEqual([])
    expect(() => owners.apply(room, {}, update([1]))).not.toThrow()
  })

  it("drops another peer's clients from an update, as stock y-websocket clients echo them, and keeps its own", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const first = {}
    const second = {}
    owners.apply(room, first, update([1]))

    // The echo of client 1 is dropped; client 2 is claimed by the peer that sent it.
    expect(owners.apply(room, second, update([2, 1]))).toEqual([2])
    expect(owners.apply(room, second, update([1]))).toEqual([])
    expect(owners.release(second)).toEqual([2])
    expect(owners.release(first)).toEqual([1])
  })

  it("rolls back failed new claims and preserves previous claims", () => {
    const owners = createRealtimeAwarenessOwners({ maxStateBytes: 512 })
    const room = roomAwareness()
    const peer = {}
    owners.apply(room, peer, update([1]))

    expect(() => owners.apply(room, peer, update([1, 2], { payload: "x".repeat(1024) }, 2))).toThrow("room quota")
    expect(room.getStates().has(2)).toBe(false)
    expect(owners.release(peer)).toEqual([1])
    expect(owners.apply(room, {}, update([2]))).toEqual([2])
  })

  it("binds identity before committing an update and frees malformed claims", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    const identity = { color: "#2563EB", id: "user", name: "Max" }
    owners.apply(room, peer, update([1], { user: { id: "forged" }, cursor: 2 }), identity)
    expect(room.getStates().get(1)).toEqual({ user: identity, cursor: 2 })

    expect(() => owners.apply(room, peer, update([2], "invalid"), identity)).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_AWARENESS" }))
    expect(owners.apply(room, {}, update([2]), identity)).toEqual([2])
    expect(owners.release(peer)).toEqual([1])
  })

  it("enforces the cumulative client quota before reserving another client", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    owners.apply(room, peer, update(Array.from({ length: 1024 }, (_, index) => index), null))

    expect(() => owners.apply(room, peer, update([1024]))).toThrow(expect.objectContaining({ code: "REALTIME_TOO_MANY_AWARENESS_CLIENTS" }))
    expect(owners.apply(room, {}, update([1024]))).toEqual([1024])
    expect(owners.release(peer)).toHaveLength(1024)
  })

  it.each([false, 0, "invalid", []])("rejects non-object identity state %j and releases its claim", (state) => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    const identity = { color: "#2563EB", id: "user", name: "Max" }

    expect(() => owners.apply(room, peer, update([1], state), identity)).toThrow(expect.objectContaining({ code: "REALTIME_INVALID_AWARENESS" }))
    expect(room.getStates().size).toBe(0)
    expect(owners.release(peer)).toEqual([])
    expect(owners.apply(room, {}, update([1]), identity)).toEqual([1])
  })

  it("preserves null identity state used to remove awareness", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    const identity = { color: "#2563EB", id: "user", name: "Max" }
    owners.apply(room, peer, update([1]), identity)

    owners.apply(room, peer, update([1], null, 2), identity)
    expect(room.getStates().has(1)).toBe(false)
    expect(owners.release(peer)).toEqual([1])
  })
})
