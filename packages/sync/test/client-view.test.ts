import { describe, expect, it, vi } from "vitest"

import { backoffDelay, pullChange, pushChange, randomUUID, readError, replayWrites, toMutation } from "../src/client/view.ts"

import type { SyncPullResponse, SyncRow } from "../src/protocol.ts"
import type { SyncMeta, SyncQueuedWrite } from "../src/client/storage.ts"

const meta: SyncMeta = { key: "id", cursor: 4, scope: { id: "scope-ada", values: { ownerId: "ada" } } }

function write(seq: number, fields: Partial<SyncQueuedWrite> & Pick<SyncQueuedWrite, "op" | "key">): SyncQueuedWrite {
  return { seq, id: `m${seq}`, scope: "scope-ada", ...fields } as SyncQueuedWrite
}

function pull(fields: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return { key: "id", scope: meta.scope, cursor: 9, reset: false, rows: [], deleted: [], more: false, ...fields }
}

describe("replayWrites", () => {
  it("applies the queued writes in order on top of the confirmed rows", () => {
    const confirmed = new Map<string, SyncRow>([["a", { id: "a", ownerId: "ada", title: "Milk" }], ["b", { id: "b", ownerId: "ada", title: "Eggs" }]])
    const view = replayWrites(confirmed, [
      write(1, { op: "insert", key: "c", value: { title: "Bread" } }),
      write(2, { op: "update", key: "a", patch: { title: "Oat milk" } }),
      write(3, { op: "update", key: "a", patch: { done: true } }),
      write(4, { op: "delete", key: "b" }),
      write(5, { op: "update", key: "gone", patch: { title: "Lost" } }),
    ], meta)
    expect([...view.values()]).toEqual([
      { id: "a", ownerId: "ada", title: "Oat milk", done: true },
      { id: "c", ownerId: "ada", title: "Bread" },
    ])
    expect(confirmed.get("a")!.title).toBe("Milk")
  })

  it("leaves out refused writes, so the row rolls back", () => {
    const confirmed = new Map<string, SyncRow>([["a", { id: "a", title: "Milk" }]])
    const view = replayWrites(confirmed, [write(1, { op: "update", key: "a", patch: { title: "Mlk" }, error: { code: "SYNC_INVALID", message: "No." } })], meta)
    expect(view.get("a")).toEqual({ id: "a", title: "Milk" })
  })

  it("keys an insert with `id` before the first pull tells the key column", () => {
    const view = replayWrites(new Map(), [write(1, { op: "insert", key: "k", scope: null, value: { title: "Milk" } })], undefined)
    expect([...view.values()]).toEqual([{ id: "k", title: "Milk" }])
  })
})

describe("toMutation", () => {
  it("writes the key and the scope values into an insert, and keeps a value that the caller set", () => {
    expect(toMutation(write(1, { op: "insert", key: "k", value: { title: "Milk", ownerId: "bob" } }), meta)).toEqual({ id: "m1", op: "insert", value: { ownerId: "bob", title: "Milk", id: "k" } })
    expect(toMutation(write(2, { op: "update", key: "k", patch: { done: true } }), meta)).toEqual({ id: "m2", op: "update", key: "k", patch: { done: true } })
    expect(toMutation(write(3, { op: "delete", key: "k" }), meta)).toEqual({ id: "m3", op: "delete", key: "k" })
  })
})

describe("pullChange", () => {
  it("merges an incremental pull and moves the cursor", () => {
    expect(pullChange(meta, pull({ rows: [{ id: "a", title: "Milk" }], deleted: ["b"] }), [])).toEqual({
      meta: { key: "id", cursor: 9, scope: meta.scope },
      reset: false,
      put: [["a", { id: "a", title: "Milk" }]],
      delete: ["b"],
      update: [],
    })
  })

  it("fails queued writes of another scope and binds writes made before the first pull", () => {
    const old = write(1, { op: "insert", key: "x", value: { title: "Ada's" } })
    const early = write(2, { op: "insert", key: "y", scope: null, value: { title: "Early" } })
    const failed = write(3, { op: "delete", key: "z", error: { code: "SYNC_NOT_FOUND", message: "No." } })
    const bob = { id: "scope-bob", values: { ownerId: "bob" } }
    const change = pullChange(meta, pull({ scope: bob, reset: true, rows: [{ id: "b" }] }), [old, early, failed])
    expect(change.reset).toBe(true)
    expect(change.update).toEqual([
      { ...old, error: { code: "SYNC_SCOPE_CHANGED", message: expect.any(String) } },
      { ...early, scope: "scope-bob" },
    ])
  })
})

describe("pushChange", () => {
  it("removes confirmed writes, keeps refused ones with their error, and keeps writes without an answer", () => {
    const sent = [write(1, { op: "delete", key: "a" }), write(2, { op: "delete", key: "b" }), write(3, { op: "delete", key: "c" }), write(4, { op: "delete", key: "d" })]
    const error = { code: "SYNC_NOT_FOUND" as const, message: "No such row." }
    expect(pushChange(sent, [{ id: "m1", status: "applied" }, { id: "m2", status: "duplicate" }, { id: "m3", status: "rejected", error }])).toEqual({
      remove: [1, 2],
      update: [{ ...sent[2], error }],
    })
  })
})

describe("backoffDelay", () => {
  it("doubles from 1 s to 30 s with jitter on the upper half", () => {
    expect(backoffDelay(0, 0)).toBe(500)
    expect(backoffDelay(0, 1)).toBe(1000)
    expect(backoffDelay(3, 0.5)).toBe(6000)
    expect(backoffDelay(20, 1)).toBe(30_000)
  })
})

describe("readError", () => {
  it("reads the code of a ViteHub error body, and names the status when the body has none", () => {
    expect(readError(403, { code: "SYNC_FORBIDDEN", message: "No.", why: "No." })).toMatchObject({ code: "SYNC_FORBIDDEN", message: "No.", status: 403 })
    expect(readError(400, { code: "SYNC_INVALID", message: "Bad.", issues: [{ path: "title", message: "Short." }] })).toMatchObject({ issues: [{ path: "title", message: "Short." }] })
    expect(readError(401, "<html>")).toMatchObject({ code: "SYNC_UNAUTHORIZED", status: 401 })
    expect(readError(409, undefined)).toMatchObject({ code: "SYNC_SCOPE_CHANGED" })
    expect(readError(502, { code: "SYNC_BAD_REQUEST", message: "Proxy." })).toMatchObject({ code: "SYNC_SERVER_ERROR", status: 502 })
    expect(readError(418, { code: "NOT_SYNC" })).toMatchObject({ code: "SYNC_BAD_REQUEST", status: 418 })
  })
})

describe("randomUUID", () => {
  it("makes a version 4 UUID also where crypto.randomUUID() is missing, as on a LAN address over HTTP", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(randomUUID()).toMatch(uuid)
    const real = globalThis.crypto
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array) })
    try {
      const keys = new Set(Array.from({ length: 100 }, () => randomUUID()))
      expect(keys.size).toBe(100)
      for (const key of keys) expect(key).toMatch(uuid)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
