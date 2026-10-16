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

afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.destroy()
    room.doc.destroy()
  }
})

describe("realtime awareness ownership", () => {
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

    expect(() => owners.apply(room, peer, update([2], "invalid"), identity)).toThrow("Invalid awareness state")
    expect(owners.apply(room, {}, update([2]), identity)).toEqual([2])
    expect(owners.release(peer)).toEqual([1])
  })

  it("enforces the cumulative client quota before reserving another client", () => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    owners.apply(room, peer, update(Array.from({ length: 1024 }, (_, index) => index), null))

    expect(() => owners.apply(room, peer, update([1024]))).toThrow("too many awareness clients")
    expect(owners.apply(room, {}, update([1024]))).toEqual([1024])
    expect(owners.release(peer)).toHaveLength(1024)
  })

  it.each([false, 0, "invalid", []])("rejects non-object identity state %j and releases its claim", (state) => {
    const owners = createRealtimeAwarenessOwners()
    const room = roomAwareness()
    const peer = {}
    const identity = { color: "#2563EB", id: "user", name: "Max" }

    expect(() => owners.apply(room, peer, update([1], state), identity)).toThrow("Invalid awareness state")
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
