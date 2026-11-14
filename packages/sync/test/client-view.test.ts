import { describe, expect, it, vi } from "vitest"

import { backoffDelay, buildView, mergeTarget, pullChange, pushChange, randomUUID, readError, toMutation, whereKey } from "../src/client/view.ts"

import type { SyncPullResponse, SyncRow } from "../src/protocol.ts"
import type { SyncMeta, SyncQueuedWrite } from "../src/client/storage.ts"
import type { SyncLocal } from "../src/client/types.ts"
import type { SyncViewContext } from "../src/client/view.ts"

const meta: SyncMeta = { key: "id", cursor: 4, scope: { id: "scope-ada", values: { ownerId: "ada", teamId: ["t1", "t2"] } }, account: "account-ada", version: "v1", defaults: { done: false, note: null } }

function write(seq: number, fields: Partial<SyncQueuedWrite> & Pick<SyncQueuedWrite, "op" | "key">): SyncQueuedWrite {
  // SAFETY: each test passes the fields of its op.
  return { seq, id: `m${seq}`, account: "account-ada", ...fields } as SyncQueuedWrite
}

function pull(fields: Partial<SyncPullResponse> = {}): SyncPullResponse {
  return { key: "id", scope: meta.scope, account: meta.account, version: meta.version, defaults: meta.defaults, cursor: 9, reset: false, rows: [], deleted: [], more: false, ...fields }
}

function context(fields: Partial<SyncViewContext> = {}): SyncViewContext {
  return { meta, where: {}, actions: new Map(), report: () => undefined, ...fields }
}

describe("buildView", () => {
  it("applies the queued writes in order on top of the confirmed rows", () => {
    const confirmed = new Map<string, SyncRow>([["a", { id: "a", ownerId: "ada", title: "Milk" }], ["b", { id: "b", ownerId: "ada", title: "Eggs" }]])
    const view = buildView(confirmed, [
      write(1, { op: "insert", key: "c", value: { title: "Bread" } }),
      write(2, { op: "update", key: "a", patch: { title: "Oat milk" } }),
      write(3, { op: "update", key: "a", patch: { done: true } }),
      write(4, { op: "delete", key: "b" }),
      write(5, { op: "update", key: "gone", patch: { title: "Lost" } }),
    ], context())
    expect([...view.rows.values()]).toEqual([
      { id: "a", ownerId: "ada", title: "Oat milk", done: true },
      // The defaults, then the single scope values. The list of teams has no one value.
      { id: "c", ownerId: "ada", done: false, note: null, title: "Bread" },
    ])
    expect([...view.pending]).toEqual(["c", "a", "b", "gone"])
    expect(confirmed.get("a")!.title).toBe("Milk")
  })

  it("leaves out refused writes and writes of another account, so the rows show the server copy", () => {
    const confirmed = new Map<string, SyncRow>([["a", { id: "a", title: "Milk" }]])
    const view = buildView(confirmed, [
      write(1, { op: "update", key: "a", patch: { title: "Mlk" }, error: { code: "SYNC_INVALID", message: "No." } }),
      write(2, { op: "update", key: "a", patch: { title: "Bob's" }, account: "account-bob" }),
    ], context())
    expect(view.rows.get("a")).toEqual({ id: "a", title: "Milk" })
    expect(view.pending.size).toBe(0)
  })

  it("keys an insert with `id` before the first pull, and adds the subset", () => {
    const view = buildView(new Map(), [write(1, { op: "insert", key: "k", account: null, value: { title: "Milk" } })], context({ meta: undefined, where: { issueId: "i1" } }))
    expect([...view.rows.values()]).toEqual([{ id: "k", issueId: "i1", title: "Milk" }])
  })

  it("runs the optimistic function of an action, with keys from the action id", () => {
    const confirmed = new Map<string, SyncRow>([["a", { id: "a", ownerId: "ada", title: "Milk", done: false }]])
    const complete = (local: SyncLocal<SyncRow>, args: unknown) => {
      const { id } = args as { id: string }
      local.update(id, { done: true })
      local.insert({ title: `Done: ${String(local.get(id)?.title)}` })
      local.insert({ title: "Second" })
    }
    const actions = new Map([["complete", complete]])
    const writes = [write(1, { op: "action", key: "m1", name: "complete", args: { id: "a" } }), write(2, { op: "action", key: "m2", name: "unknown", args: {} })]
    const first = buildView(confirmed, writes, context({ actions }))
    expect([...first.rows.values()]).toEqual([
      { id: "a", ownerId: "ada", title: "Milk", done: true },
      { id: "m1", ownerId: "ada", done: false, note: null, title: "Done: Milk" },
      { id: "m1-1", ownerId: "ada", done: false, note: null, title: "Second" },
    ])
    expect([...first.pending]).toEqual(["a", "m1", "m1-1"])
    // A replay gives the same keys.
    expect([...buildView(confirmed, writes, context({ actions })).rows.keys()]).toEqual(["a", "m1", "m1-1"])
  })

  it("reports an optimistic function that throws, and still applies the other writes", () => {
    const reports: unknown[] = []
    const view = buildView(new Map(), [
      write(1, { op: "action", key: "m1", name: "broken", args: {} }),
      write(2, { op: "insert", key: "k", value: { title: "Milk" } }),
    ], context({ actions: new Map([["broken", () => {
      throw new Error("Oops")
    }]]), report: (_write, error) => reports.push(error) }))
    expect([...view.rows.keys()]).toEqual(["k"])
    expect(reports).toMatchObject([{ message: "Oops" }])
  })
})

describe("toMutation", () => {
  it("writes the key and the single scope values into an insert, never the defaults, and keeps a value that the caller set", () => {
    expect(toMutation(write(1, { op: "insert", key: "k", value: { title: "Milk", ownerId: "bob", teamId: "t2" } }), meta)).toEqual({ id: "m1", op: "insert", value: { ownerId: "bob", teamId: "t2", title: "Milk", id: "k" } })
    expect(toMutation(write(2, { op: "update", key: "k", patch: { done: true } }), meta)).toEqual({ id: "m2", op: "update", key: "k", patch: { done: true } })
    expect(toMutation(write(3, { op: "delete", key: "k" }), meta)).toEqual({ id: "m3", op: "delete", key: "k" })
    expect(toMutation(write(4, { op: "action", key: "m4", name: "complete", args: { id: "k" } }), meta)).toEqual({ id: "m4", op: "action", name: "complete", args: { id: "k" } })
  })
})

describe("pullChange", () => {
  it("merges an incremental pull and moves the cursor", () => {
    expect(pullChange(meta, pull({ rows: [{ id: "a", title: "Milk" }], deleted: ["b"] }), [])).toEqual({
      meta: { ...meta, cursor: 9 },
      reset: false,
      put: [["a", { id: "a", title: "Milk" }]],
      delete: ["b"],
      update: [],
    })
  })

  it("keeps queued writes of another account, and gives writes made before the first pull its account", () => {
    const old = write(1, { op: "insert", key: "x", value: { title: "Ada's" } })
    const early = write(2, { op: "insert", key: "y", account: null, value: { title: "Early" } })
    const bob = { id: "scope-bob", values: { ownerId: "bob" } }
    const change = pullChange(meta, pull({ scope: bob, account: "account-bob", reset: true, rows: [{ id: "b" }] }), [old, early])
    expect(change.reset).toBe(true)
    expect(change.meta!.account).toBe("account-bob")
    expect(change.update).toEqual([{ ...early, account: "account-bob" }])
  })

  it("drops the rows when the table version changes", () => {
    expect(pullChange(meta, pull({ version: "v2" }), []).reset).toBe(true)
    expect(pullChange(meta, pull(), []).reset).toBe(false)
  })
})

describe("pushChange", () => {
  it("removes confirmed writes, keeps refused ones with their error, keeps writes without an answer, and keeps action results", () => {
    const sent = [write(1, { op: "delete", key: "a" }), write(2, { op: "delete", key: "b" }), write(3, { op: "delete", key: "c" }), write(4, { op: "delete", key: "d" }), write(5, { op: "action", key: "m5", name: "complete", args: {} })]
    const error = { code: "SYNC_NOT_FOUND" as const, message: "No such row." }
    expect(pushChange(sent, [{ id: "m1", status: "applied" }, { id: "m2", status: "duplicate" }, { id: "m3", status: "rejected", error }, { id: "m5", status: "applied", result: { count: 2 } }])).toEqual({
      remove: [1, 2, 5],
      update: [{ ...sent[2], error }],
      results: new Map([["m5", { count: 2 }]]),
    })
  })
})

describe("mergeTarget", () => {
  it("finds the last unsent update of the key, and stops at another write of the key or at an action", () => {
    const first = write(1, { op: "update", key: "a", patch: { title: "1" } })
    const other = write(2, { op: "update", key: "b", patch: { title: "2" } })
    expect(mergeTarget([first, other], "a", meta.account, new Set())).toBe(first)
    expect(mergeTarget([first, other], "a", meta.account, new Set(["m1"]))).toBeUndefined()
    expect(mergeTarget([first, write(3, { op: "delete", key: "a" })], "a", meta.account, new Set())).toBeUndefined()
    expect(mergeTarget([first, write(3, { op: "action", key: "m3", name: "rename", args: {} })], "a", meta.account, new Set())).toBeUndefined()
    expect(mergeTarget([write(1, { op: "insert", key: "a", value: {} })], "a", meta.account, new Set())).toBeUndefined()
    expect(mergeTarget([first, write(4, { op: "update", key: "a", patch: {}, error: { code: "SYNC_INVALID", message: "No." } })], "a", meta.account, new Set())).toBe(first)
  })
})

describe("whereKey", () => {
  it("is the same for the same values in any order, and empty without a subset", () => {
    expect(whereKey({ b: 1, a: "x" })).toBe(whereKey({ a: "x", b: 1 }))
    expect(whereKey({ a: "x", b: undefined })).toBe(`{"a":"x"}`)
    expect(whereKey(undefined)).toBe("")
    expect(whereKey({ a: undefined })).toBe("")
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
