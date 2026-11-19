import { afterEach, describe, expect, it } from "vitest"

import { createMemoryStorage } from "../src/client/storage.ts"
import { SyncError } from "../src/client/types.ts"
import { syncLiveRoute } from "../src/protocol.ts"
import { accountOf, createFakeSyncServer, scopeIdOf } from "./client-fake-server.ts"
import { createHarness, until } from "./client-harness.ts"

import type { SyncValues } from "../src/protocol.ts"
import type { SyncStorage } from "../src/client/storage.ts"
import type { SyncPage } from "../src/client/store.ts"
import type { SyncLocal, SyncStore } from "../src/client/types.ts"
import type { FakeSyncServer } from "./client-fake-server.ts"
import type { Harness, Tab, Todo, TodoActions } from "./client-harness.ts"

let harness: Harness

afterEach(() => harness?.close())

/** A harness whose server has no live stream, so only the tests of live streams see one. */
function setup(): Harness {
  harness = createHarness()
  harness.server.live = false
  return harness
}

function seed(h: Harness, rows: Todo[]): void {
  for (const row of rows) h.server.write({ ...row })
}

const isLive = (input: unknown) => new URL(String(input), "http://app.test").pathname === syncLiveRoute
const posts = (h: Harness) => h.server.requests.filter(request => request.method === "POST" && !isLive(request.url))
const pulls = (h: Harness) => h.server.requests.filter(request => request.method === "GET")
const streams = (h: Harness) => h.server.requests.filter(request => isLive(request.url))

describe("start and pull", () => {
  it("pulls the caller's rows on start and shows them", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }, { id: "b", ownerId: "bob", title: "Not mine" }])
    const { store } = h.open()
    const statuses = [store.getState().status]
    store.subscribe(() => {
      if (statuses.at(-1) !== store.getState().status) statuses.push(store.getState().status)
    })
    await store.refresh()
    // `idle` until the stored rows are read, as on the server, then `loading` until the first pull.
    expect(statuses).toEqual(["idle", "loading", "ready"])
    expect(store.getState()).toMatchObject({ status: "ready", error: null, queued: 0, rows: [{ id: "a", title: "Milk" }] })
    expect(pulls(h)[0]!.url.searchParams.has("cursor")).toBe(false)
  })

  it("merges later changes and deletes from the cursor", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }, { id: "b", ownerId: "ada", title: "Eggs" }])
    const { store } = h.open()
    await store.refresh()
    h.server.write({ id: "a", ownerId: "ada", title: "Oat milk" })
    h.server.write({ id: "c", ownerId: "ada", title: "Bread" })
    h.server.remove("b")
    await store.refresh()
    const last = pulls(h).at(-1)!.url.searchParams
    expect([last.get("cursor"), last.get("scope"), last.get("version")]).toEqual(["2", scopeIdOf({ name: "todos", ownerId: "ada" }), "v1"])
    expect(store.getState().rows.map(row => [row.id, row.title])).toEqual([["a", "Oat milk"], ["c", "Bread"]])
    expect(store.get("a")?.title).toBe("Oat milk")
  })

  it("resolves a write with its row when the row comes on a later page of the push answer", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    h.server.pageSize = 1
    seed(h, [{ id: "a", ownerId: "ada", title: "1" }, { id: "b", ownerId: "ada", title: "2" }, { id: "c", ownerId: "ada", title: "3" }])
    const row = await store.insert({ id: "d", title: "4" })
    expect(row).toMatchObject({ id: "d", title: "4" })
    expect(store.getState().rows.map(item => item.id)).toEqual(["a", "b", "c", "d"])
  })

  it("pulls a snapshot in pages, and takes the rows that changed between two pages", async () => {
    const h = setup()
    h.server.snapshotPageSize = 5
    seed(h, Array.from({ length: 12 }, (_, index) => ({ id: `r${String(index).padStart(2, "0")}`, ownerId: "ada", title: "old" })))
    let answered = 0
    const { store } = h.open({
      fetch: async (input, init) => {
        const response = await h.server.fetch(input, init)
        if (++answered === 1) h.server.write({ id: "r00", ownerId: "ada", title: "changed" })
        return response
      },
    })
    await store.refresh()
    expect(pulls(h).map(request => [request.url.searchParams.get("paged"), request.url.searchParams.get("after")])).toEqual([["1", null], ["1", "r04"], ["1", "r09"], ["1", null]])
    expect(store.getState().rows).toHaveLength(12)
    expect(store.get("r00")?.title).toBe("changed")
  })

  it("goes on with a paged snapshot from the stored page after a reload", async () => {
    const h = setup()
    h.server.snapshotPageSize = 5
    seed(h, Array.from({ length: 12 }, (_, index) => ({ id: `r${String(index).padStart(2, "0")}`, ownerId: "ada", title: "old" })))
    let answered = 0
    const first = h.open({
      fetch: async (input, init) => {
        if (++answered > 1) throw new TypeError("Failed to fetch")
        return await h.server.fetch(input, init)
      },
    })
    await first.store.refresh()
    expect(first.store.getState().rows).toHaveLength(5)
    first.store.destroy()
    const { store } = h.open()
    await store.refresh()
    expect(pulls(h).at(-2)!.url.searchParams.get("after")).toBe("r04")
    expect(store.getState().rows).toHaveLength(12)
  })

  it("is ready and complete only once the last page of a snapshot is in, also after a reload between two pages", async () => {
    const h = setup()
    h.server.snapshotPageSize = 5
    seed(h, Array.from({ length: 8 }, (_, index) => ({ id: `r${index}`, ownerId: "ada", title: "old" })))
    let answered = 0
    const first = h.open({
      fetch: async (input, init) => {
        if (++answered > 1) throw new TypeError("Failed to fetch")
        return await h.server.fetch(input, init)
      },
    })
    const seen: [string, number, boolean][] = []
    first.store.subscribe(() => {
      const { status, rows, complete } = first.store.getState()
      seen.push([status, rows.length, complete])
    })
    await first.store.refresh()
    expect(seen.some(([status, , complete]) => status === "ready" || complete)).toBe(false)
    expect(first.store.getState()).toMatchObject({ status: "offline", complete: false })
    expect(first.store.getState().rows).toHaveLength(5)
    first.store.destroy()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { store } = h.open({
      fetch: async (input, init) => {
        await gate
        return await h.server.fetch(input, init)
      },
    })
    await until(() => store.getState().rows.length === 5)
    expect(store.getState()).toMatchObject({ status: "loading", complete: false })
    release()
    await store.refresh()
    expect(pulls(h).map(request => request.url.searchParams.get("after"))).toContain("r4")
    expect(store.getState()).toMatchObject({ status: "ready", complete: true })
    expect(store.getState().rows).toHaveLength(8)
  })

  it("is complete after a snapshot in one answer, and stays complete offline", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store } = h.open()
    expect(store.getState().complete).toBe(false)
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "ready", complete: true })
    h.server.failWith = 503
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "error", complete: true })
  })

  it("starts the snapshot again when the server answers its next page with changes, as a server without paging", async () => {
    const h = setup()
    h.server.snapshotPageSize = 5
    seed(h, Array.from({ length: 12 }, (_, index) => ({ id: `r${String(index).padStart(2, "0")}`, ownerId: "ada", title: "old" })))
    let answered = 0
    const { store } = h.open({
      fetch: async (input, init) => {
        const response = await h.server.fetch(input, init)
        if (++answered === 1) h.server.paging = false
        return response
      },
    })
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "ready" })
    expect(store.getState().rows).toHaveLength(12)
  })

  it("pulls again while the server has more changes", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    h.server.pageSize = 1
    seed(h, [{ id: "a", ownerId: "ada", title: "1" }, { id: "b", ownerId: "ada", title: "2" }, { id: "c", ownerId: "ada", title: "3" }])
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual(["a", "b", "c"])
  })

  it("replaces the rows when the server resets the cursor", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store } = h.open()
    await store.refresh()
    h.server.remove("a")
    h.server.write({ id: "b", ownerId: "ada", title: "Eggs" })
    h.server.compact()
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual(["b"])
  })

  it("keeps the queue and shows the error when the caller may not sync", async () => {
    const h = setup()
    const { store, browser } = h.open()
    await store.refresh()
    browser.emit("offline")
    h.server.offline = true
    store.insert({ title: "Milk" })
    h.server.offline = false
    h.server.user = null
    browser.emit("online")
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "error", queued: 1, error: { code: "SYNC_UNAUTHORIZED" } })
    expect(store.getState().error).toBeInstanceOf(SyncError)
  })

  it("is offline when the network fails, and ready again after", async () => {
    const h = setup()
    const { store } = h.open()
    h.server.offline = true
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "offline", error: { code: "SYNC_NETWORK" } })
    h.server.offline = false
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "ready", error: null })
  })
})

describe("writes", () => {
  it("fills the key and the scope values on insert, and shows the row at once", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    const write = store.insert({ title: "Milk" })
    expect(write.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(write.state).toBe("queued")
    expect(store.getState()).toMatchObject({ queued: 1, rows: [{ id: write.key, ownerId: "ada", title: "Milk" }] })
    const row = await write
    expect(write.state).toBe("applied")
    expect(row).toEqual({ id: write.key, ownerId: "ada", title: "Milk" })
    expect(h.server.rows.get(write.key)).toEqual({ id: write.key, ownerId: "ada", title: "Milk" })
    expect(store.getState().queued).toBe(0)
  })

  it("keeps the same state object until something changes", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    const before = store.getState()
    expect(store.getState()).toBe(before)
    // A pull that brings nothing does not make a new state.
    await store.refresh()
    expect(store.getState()).toBe(before)
    let calls = 0
    const stop = store.subscribe(() => calls++)
    store.insert({ title: "Milk" })
    expect(store.getState()).not.toBe(before)
    expect(calls).toBeGreaterThan(0)
    stop()
  })

  it("writes to the outbox before it sends", async () => {
    const h = setup()
    const log: string[] = []
    const memory = createMemoryStorage()
    let release: () => void = () => undefined
    const slow: SyncStorage = {
      ...memory,
      get persisted() { return memory.persisted },
      async write(id, change) {
        if (change.add?.length) {
          log.push("persist start")
          await new Promise<void>(resolve => { release = resolve })
          log.push("persist end")
        }
        return memory.write(id, change)
      },
    }
    const { store } = h.open({
      storage: slow,
      fetch: async (input, init) => {
        if (init?.method === "POST" && !isLive(input)) log.push("send")
        return h.server.fetch(input, init)
      },
    })
    await store.refresh()
    const write = store.insert({ title: "Milk" })
    void store.refresh()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(log).toEqual(["persist start"])
    release()
    await write
    expect(log).toEqual(["persist start", "persist end", "send"])
  })

  it("sends one push at a time, with every queued write in order", async () => {
    const h = setup()
    let inFlight = 0
    let most = 0
    const { store, browser } = h.open({
      fetch: async (input, init) => {
        if (isLive(input)) return h.server.fetch(input, init)
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        try {
          return await h.server.fetch(input, init)
        }
        finally {
          inFlight--
        }
      },
    })
    await store.refresh()
    const writes = [store.insert({ title: "1" }), store.insert({ title: "2" }), store.insert({ title: "3" })]
    browser.emit("visible")
    browser.emit("online")
    void store.refresh()
    await Promise.all(writes)
    expect(most).toBe(1)
    expect(h.server.applied.map(mutation => mutation.op === "insert" && mutation.value.title)).toEqual(["1", "2", "3"])
  })

  it("merges two offline updates of one row, and sends the last value (farm.js: writes raced)", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store, browser } = h.open()
    await store.refresh()
    h.server.offline = true
    browser.emit("offline")
    store.update("a", { title: "Oat milk" })
    store.update("a", { title: "Soy milk" })
    expect(store.get("a")?.title).toBe("Soy milk")
    h.server.offline = false
    browser.emit("online")
    await store.refresh()
    expect(h.server.applied.map(mutation => mutation.op === "update" && mutation.patch.title)).toEqual(["Soy milk"])
    expect(h.server.rows.get("a")?.title).toBe("Soy milk")
    expect(store.getState()).toMatchObject({ queued: 0, rows: [{ id: "a", title: "Soy milk" }] })
  })

  it("merges only within one tick, so a patch of a later tick is its own update", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const { store } = h.open()
    await store.refresh()
    h.server.offline = true
    store.update("a", { title: "Oat milk" }).then(undefined, () => undefined)
    await until(() => store.getState().status === "offline")
    store.update("a", { done: true }).then(undefined, () => undefined)
    expect(store.getState().queued).toBe(2)
    h.server.offline = false
    await store.refresh()
    expect(h.server.applied.map(mutation => mutation.op === "update" && mutation.patch)).toEqual([{ title: "Oat milk" }, { done: true }])
  })

  it("deletes a row at once and on the server", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store } = h.open()
    await store.refresh()
    const write = store.delete("a")
    expect(store.getState().rows).toEqual([])
    expect(await write).toBeUndefined()
    expect(h.server.rows.has("a")).toBe(false)
  })

  it("gives one row when a lost answer is retried (farm.js: false rollback)", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    h.server.loseNextResponse = true
    const write = store.insert({ title: "Milk" })
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "offline", queued: 1 })
    expect(h.server.applied).toHaveLength(1)
    await store.refresh()
    expect(await write).toMatchObject({ title: "Milk" })
    expect(posts(h).at(-1)!.body!.mutations).toHaveLength(1)
    expect(store.getState()).toMatchObject({ status: "ready", queued: 0, failures: [] })
    expect(store.getState().rows).toHaveLength(1)
    expect(h.server.rows.size).toBe(1)
    expect(h.server.applied).toHaveLength(1)
  })

  it("rolls back a refused write, and retry applies its patch on the latest row (farm.js: stale retry)", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const { store } = h.open()
    await store.refresh()
    h.server.refuse = mutation => mutation.op === "update" && mutation.patch.title === "Mlk" ? { code: "SYNC_INVALID", message: "Check the title.", issues: [{ path: "title", message: "Too short." }] } : undefined
    const write = store.update("a", { title: "Mlk" })
    expect(store.get("a")?.title).toBe("Mlk")
    const error = await write.then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(SyncError)
    expect(error).toMatchObject({ code: "SYNC_INVALID", issues: [{ path: "title" }] })
    expect(write.state).toBe("rejected")
    const state = store.getState()
    expect(state.rows).toEqual([{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    expect(state.queued).toBe(0)
    expect(state.failures).toHaveLength(1)
    expect(state.failures[0]).toMatchObject({ key: "a", mutation: { op: "update", key: "a", patch: { title: "Mlk" } }, error: { code: "SYNC_INVALID" } })

    // Another client changes the row before the retry.
    h.server.write({ id: "a", ownerId: "ada", title: "Milk", done: true })
    await store.refresh()
    h.server.refuse = undefined
    const again = store.retry(state.failures[0]!)
    expect(store.get("a")).toEqual({ id: "a", ownerId: "ada", title: "Mlk", done: true })
    expect(store.getState().failures).toEqual([])
    await again
    expect(h.server.rows.get("a")).toEqual({ id: "a", ownerId: "ada", title: "Mlk", done: true })
    expect(h.server.applied.at(-1)).toMatchObject({ op: "update", patch: { title: "Mlk" } })
    expect(h.server.applied.at(-1)!.id).not.toBe(state.failures[0]!.mutation.id)
  })

  it("drops a failure on dismiss", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    h.server.refuse = () => ({ code: "SYNC_READ_ONLY", message: "Read only." })
    await store.insert({ title: "Milk" }).then(undefined, () => undefined)
    expect(store.getState().failures).toHaveLength(1)
    store.dismiss(store.getState().failures[0]!)
    expect(store.getState()).toMatchObject({ failures: [], rows: [] })
    await store.refresh()
    expect(store.getState().failures).toEqual([])
  })

  it("moves the writes of a push to failures when the server refuses the whole request", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    const fetch: typeof globalThis.fetch = async (input, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ code: "SYNC_BAD_REQUEST", message: "Bad body." }), { status: 400 })
      : h.server.fetch(input, init)
    const tab = h.open({ fetch, storage: createMemoryStorage() })
    await tab.store.refresh()
    const write = tab.store.insert({ title: "Milk" })
    await expect(write).rejects.toMatchObject({ code: "SYNC_BAD_REQUEST" })
    expect(tab.store.getState()).toMatchObject({ queued: 0, failures: [{ error: { code: "SYNC_BAD_REQUEST" } }] })
  })
})

describe("accounts", () => {
  it("keeps writes of one account after a switch, and sends them when that account is back (farm.js: wrong cookies)", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const { store, browser } = h.open()
    await store.refresh()
    h.server.offline = true
    browser.emit("offline")
    const insert = store.insert({ title: "Ada's secret" })
    store.update("a", { title: "Ada's edit" })
    expect(store.getState().queued).toBe(2)

    // Another person signs in on this device while it is offline.
    h.server.user = "bob"
    h.server.offline = false
    browser.emit("online")
    await store.refresh()
    expect(h.server.applied).toEqual([])
    expect(posts(h)).toEqual([])
    const state = store.getState()
    expect(state.rows.map(row => row.id)).toEqual(["b"])
    expect(state).toMatchObject({ queued: 0, failures: [] })
    expect(store.pending("a")).toBe(false)
    expect(insert.state).toBe("queued")

    // Bob's writes go out. Ada's stay.
    await store.insert({ title: "Bob's new" })
    expect(h.server.applied).toHaveLength(1)
    expect(posts(h).flatMap(post => post.body!.mutations)).toHaveLength(1)

    // Ada signs in again. Her writes go out with her session.
    h.server.user = "ada"
    await store.refresh()
    expect(await insert).toMatchObject({ title: "Ada's secret", ownerId: "ada" })
    await until(() => store.getState().queued === 0)
    expect(h.server.rows.get("a")?.title).toBe("Ada's edit")
    expect(posts(h).at(-1)!.body!.account).toBe(accountOf("ada"))
  })

  it("keeps the writes of a push that the server answers with 409, and pulls the new account", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const { store } = h.open()
    await store.refresh()
    // The session changes without an event that makes the store pull first.
    h.server.user = "bob"
    const write = store.insert({ title: "Ada's secret" })
    await until(() => store.getState().rows.length === 1 && store.getState().rows[0]!.id === "b")
    expect(posts(h).map(post => post.body!.account)).toEqual([accountOf("ada")])
    expect(h.server.applied).toEqual([])
    expect(store.getState()).toMatchObject({ queued: 0, failures: [], status: "ready" })
    expect(write.state).toBe("queued")
    const stored = await h.storage.readQueue("/_vitehub/sync/todos")
    expect(stored.writes).toMatchObject([{ id: expect.any(String), account: accountOf("ada"), op: "insert" }])
  })

  it("keeps writes of two accounts over a reload, and shows only the current account's", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const first = h.open()
    await first.store.refresh()
    h.server.offline = true
    first.store.insert({ title: "Ada's offline" })
    await first.store.refresh()
    h.server.offline = false
    h.server.user = "bob"
    await first.store.refresh()
    h.server.offline = true
    first.store.insert({ title: "Bob's offline" })
    await first.store.refresh()
    first.store.destroy()

    // A reload signed in as Bob, while the network is down.
    const reload = h.open()
    await until(() => reload.store.getState().status === "offline")
    expect(reload.store.getState().rows.map(row => row.title)).toEqual(["Bob's", "Bob's offline"])
    expect(reload.store.getState().queued).toBe(1)
    h.server.offline = false
    await reload.store.refresh()
    expect(h.server.applied.map(mutation => mutation.op === "insert" && mutation.value.title)).toEqual(["Bob's offline"])
    h.server.user = "ada"
    await reload.store.refresh()
    await until(() => reload.store.getState().queued === 0)
    expect(h.server.applied.map(mutation => mutation.op === "insert" && mutation.value.title)).toEqual(["Bob's offline", "Ada's offline"])
    expect(reload.store.getState().rows.map(row => row.title)).toEqual(["Ada's", "Ada's offline"])
  })

  it("stops pushing after a 409 when the pull keeps the same account", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    const fetch: typeof globalThis.fetch = async (input, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ code: "SYNC_ACCOUNT_CHANGED", message: "Another account." }), { status: 409 })
      : h.server.fetch(input, init)
    const tab = h.open({ fetch, storage: createMemoryStorage() })
    await tab.store.refresh()
    tab.store.insert({ title: "Milk" })
    await until(() => tab.store.getState().status === "error")
    expect(tab.store.getState()).toMatchObject({ queued: 1, failures: [], error: { code: "SYNC_ACCOUNT_CHANGED" } })
  })
})

describe("table versions and defaults", () => {
  it("drops the stored rows when the table changes, and keeps the queued writes", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store, browser } = h.open()
    await store.refresh()
    h.server.offline = true
    browser.emit("offline")
    const write = store.update("a", { title: "Oat milk" })
    await store.refresh()
    // The table changes on deploy, and the server rows change with it.
    h.server.version = "v2"
    h.server.compact()
    h.server.write({ id: "a", ownerId: "ada", title: "Milk", note: "new column" })
    h.server.offline = false
    browser.emit("online")
    await write
    expect(pulls(h).at(-1)!.url.searchParams.get("version")).toBe("v1")
    expect(store.getState().rows).toEqual([{ id: "a", ownerId: "ada", title: "Oat milk", note: "new column" }])
    expect(posts(h).at(-1)!.body).toMatchObject({ version: "v2" })
  })

  it("shows the defaults in an optimistic insert, and leaves them out of the push", async () => {
    const h = setup()
    h.server.defaults = { done: false, note: null }
    const { store } = h.open()
    await store.refresh()
    const write = store.insert({ title: "Milk" })
    expect(store.get(write.key)).toEqual({ id: write.key, ownerId: "ada", done: false, note: null, title: "Milk" })
    await write
    expect(posts(h)[0]!.body!.mutations).toEqual([{ id: expect.any(String), op: "insert", value: { ownerId: "ada", title: "Milk", id: write.key } }])
  })
})

describe("team scopes and subsets", () => {
  it("writes a team that the caller chose, and drops a row that moved to another team", async () => {
    const h = setup()
    h.server.where = () => ({ teamId: ["t1", "t2"] })
    seed(h, [{ id: "a", ownerId: "ada", teamId: "t1", title: "Team 1" }, { id: "b", ownerId: "bob", teamId: "t3", title: "Team 3" }])
    const { store } = h.open()
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual(["a"])
    const write = store.insert({ title: "New", teamId: "t2" })
    // The list of teams has no one value, so the insert keeps the caller's.
    expect(store.get(write.key)).toEqual({ id: write.key, teamId: "t2", title: "New" })
    await write
    const refused = store.insert({ title: "Nowhere" })
    await expect(refused).rejects.toMatchObject({ code: "SYNC_OUT_OF_SCOPE" })
    // Server code moves the row to a team of someone else.
    h.server.write({ id: "a", ownerId: "ada", teamId: "t3", title: "Team 1" })
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual([write.key])
  })

  it("keeps one copy per subset, sends the subset, and fills its values on insert", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", listId: "l1", title: "In l1" }, { id: "b", ownerId: "ada", listId: "l2", title: "In l2" }])
    const one = h.open({ where: { listId: "l1" } })
    const two = h.open({ where: { listId: "l2" } })
    await Promise.all([one.store.refresh(), two.store.refresh()])
    expect(one.store.getState().rows.map(row => row.id)).toEqual(["a"])
    expect(two.store.getState().rows.map(row => row.id)).toEqual(["b"])
    expect(pulls(h).map(request => request.url.searchParams.get("where"))).toEqual([`{"listId":"l1"}`, `{"listId":"l2"}`])
    const write = one.store.insert({ title: "New in l1" })
    expect(one.store.get(write.key)).toMatchObject({ listId: "l1", ownerId: "ada" })
    await write
    expect(posts(h)[0]!.body).toMatchObject({ where: { listId: "l1" } })
    expect(h.server.rows.get(write.key)).toMatchObject({ listId: "l1" })
    expect(two.store.get(write.key)).toBeUndefined()
  })

  it("shows a subset from storage before the pull", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", listId: "l1", title: "In l1" }])
    const first = h.open({ where: { listId: "l1" } })
    await first.store.refresh()
    first.store.destroy()
    h.server.offline = true
    const again = h.open({ where: { listId: "l1" } })
    await until(() => again.store.getState().rows.length === 1)
    expect(again.store.getState().rows).toMatchObject([{ id: "a" }])
  })

  it("shows the error of a subset outside where", async () => {
    const h = setup()
    const { store } = h.open({ where: { ownerId: "bob" } })
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "error", error: { code: "SYNC_OUT_OF_SCOPE", status: 403 } })
  })
})

describe("actions", () => {
  it("queues an action and resolves with its result, with the server's rows", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    h.server.actions.complete = ({ update }, args) => {
      update((args as { id: string }).id, { done: true })
      return { completed: 1 }
    }
    const { store } = h.open()
    await store.refresh()
    const write = store.actions.complete({ id: "a" })
    // Without an optimistic function, nothing changes before the answer.
    expect(store.get("a")?.done).toBe(false)
    expect(store.getState().queued).toBe(1)
    expect(await write).toEqual({ completed: 1 })
    expect(write.state).toBe("applied")
    expect(store.get("a")?.done).toBe(true)
    expect(h.server.applied).toEqual([{ id: write.key, op: "action", name: "complete", args: { id: "a" } }])
  })

  it("shows an optimistic action at once, keeps its inserted key, and rolls it back when the server refuses it", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    h.server.actions.add = ({ insert }, args) => insert(args as { id: string, title: string })
    h.server.actions.complete = () => {
      throw new Error("Only the owner may complete it.")
    }
    const { store } = h.open({
      actions: {
        add: (local, { id, title }) => void local.insert({ ...(id ? { id } : {}), title }),
        complete: (local, { id }) => local.update(id, { done: true }),
      },
    })
    await store.refresh()
    const add = store.actions.add({ id: "new", title: "Eggs" })
    expect(store.get("new")).toMatchObject({ title: "Eggs", ownerId: "ada" })
    expect(store.pending("new")).toBe(true)
    await add
    expect(store.get("new")).toMatchObject({ title: "Eggs", ownerId: "ada" })
    expect(store.pending("new")).toBe(false)

    const keyless = store.actions.add({ title: "Bread" })
    expect(store.get(keyless.key)).toMatchObject({ title: "Bread" })

    const complete = store.actions.complete({ id: "a" })
    expect(store.get("a")?.done).toBe(true)
    await expect(complete).rejects.toMatchObject({ code: "SYNC_ACTION_REFUSED", message: "Only the owner may complete it." })
    expect(store.get("a")?.done).toBe(false)
    expect(store.getState().failures).toMatchObject([{ key: complete.key, mutation: { op: "action", name: "complete" }, error: { code: "SYNC_ACTION_REFUSED" } }])

    // A retry runs the action again.
    h.server.actions.complete = ({ update }, args) => update((args as { id: string }).id, { done: true })
    await store.retry(store.getState().failures[0]!)
    expect(store.get("a")?.done).toBe(true)
    expect(store.getState().failures).toEqual([])
  })

  it("resolves an action with its result when another tab sends it", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    h.server.actions.complete = ({ update }, args) => {
      update((args as { id: string }).id, { done: true })
      return { answer: 42 }
    }
    let down = false
    const one = h.open({ fetch: async (input, init) => {
      if (down) throw new TypeError("Failed to fetch")
      return h.server.fetch(input, init)
    } })
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    // The first tab loses the network, so the other tab sends its action.
    down = true
    const call = one.store.actions.complete({ id: "a" })
    await until(() => two.store.getState().queued === 1)
    await two.store.refresh()
    expect(await call).toEqual({ answer: 42 })
    expect(call.state).toBe("applied")
    // The tab that made the call read the result, so the storage does not keep it.
    expect(await h.storage.takeResults([call.key])).toEqual(new Map())
  })

  it("resolves an action with its first result when the answer was lost and the server answers duplicate", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    h.server.actions.complete = ({ update }, args) => {
      update((args as { id: string }).id, { done: true })
      return { answer: 42 }
    }
    const { store } = h.open()
    await store.refresh()
    h.server.loseNextResponse = true
    const call = store.actions.complete({ id: "a" })
    await until(() => store.getState().status === "offline")
    await store.refresh()
    expect(await call).toEqual({ answer: 42 })
    expect(h.server.applied).toHaveLength(1)
  })

  it("refuses an action that the server does not have", async () => {
    const h = setup()
    const { store } = h.open()
    await store.refresh()
    await expect(store.actions.archive({})).rejects.toMatchObject({ code: "SYNC_INVALID" })
    expect(store.actions.archive).toBe(store.actions.archive)
    // `then` is no action, so the object is not awaitable by mistake.
    expect(Reflect.get(store.actions, "then")).toBeUndefined()
  })
})

describe("actions across stores", () => {
  /** A page with the todos store and the comments of two todos, each comments store a subset. */
  async function crossSetup() {
    const h = setup()
    const comments = createFakeSyncServer("comments")
    comments.live = false
    h.server.actions.add = ({ insert }, args) => {
      const { id, title } = args as { id: string, title: string }
      insert({ id, title })
      // The server action writes the first comment in the same batch, as `sync("comments").insert()` does.
      comments.write({ id: `${id}-c`, ownerId: "ada", todoId: id, body: "First" })
    }
    const todos = h.open({
      actions: {
        add: (local, { id, title }) => {
          const key = local.insert({ ...(id ? { id } : {}), title })
          local.sync("comments").insert({ id: `${key}-c`, todoId: key, body: "First" })
        },
      },
    }).store
    const first = h.open({ name: "comments", fetch: comments.fetch, where: { todoId: "t1" } }).store
    const second = h.open({ name: "comments", fetch: comments.fetch, where: { todoId: "t2" } }).store
    await Promise.all([todos.refresh(), first.refresh(), second.refresh()])
    const shown: boolean[] = []
    first.subscribe(() => shown.push(first.get("t1-c") !== undefined))
    return { h, comments, todos, first, second, shown }
  }

  it("changes another open store at once, and keeps the change until that store pulled the row", async () => {
    const { comments, todos, first, second, shown } = await crossSetup()
    const call = todos.actions.add({ id: "t1", title: "Milk" })
    expect(todos.get("t1")).toMatchObject({ title: "Milk" })
    expect(first.get("t1-c")).toMatchObject({ id: "t1-c", todoId: "t1", body: "First", ownerId: "ada" })
    expect(first.pending("t1-c")).toBe(true)
    expect(shown.at(-1)).toBe(true)
    // The store of another subset does not show a row of another todo.
    expect(second.getState().rows).toEqual([])

    const pullsOf = (todoId: string) => comments.requests.filter(request => request.method === "GET" && request.url.searchParams.get("where") === JSON.stringify({ todoId })).length
    const [firstPulls, secondPulls] = [pullsOf("t1"), pullsOf("t2")]
    await call
    await until(() => pullsOf("t1") > firstPulls && first.getState().status === "ready" && !first.pending("t1-c"))
    expect(first.get("t1-c")).toMatchObject({ id: "t1-c", body: "First" })
    // From the first change on, the row never went away.
    expect(shown.slice(shown.indexOf(true))).not.toContain(false)
    // The store that did not show the row does not pull for it.
    expect(pullsOf("t2")).toBe(secondPulls)

    // The store shows the row of the server now, not the optimistic one.
    comments.remove("t1-c")
    await first.refresh()
    expect(first.get("t1-c")).toBeUndefined()
  })

  it("rolls back the change in the other store when the server refuses the action", async () => {
    const { h, todos, first, shown } = await crossSetup()
    h.server.actions.add = () => {
      throw new Error("The list is full.")
    }
    const call = todos.actions.add({ id: "t1", title: "Milk" })
    expect(first.get("t1-c")).toBeDefined()
    await expect(call).rejects.toMatchObject({ code: "SYNC_ACTION_REFUSED" })
    expect(todos.get("t1")).toBeUndefined()
    expect(first.get("t1-c")).toBeUndefined()
    expect(shown.at(-1)).toBe(false)
  })
  it("keeps the change in the other store of a tab when another tab sent the action", async () => {
    const h = setup()
    const comments = createFakeSyncServer("comments")
    comments.live = false
    h.server.actions.add = ({ insert }, args) => {
      const { id, title } = args as { id: string, title: string }
      insert({ id, title })
      comments.write({ id: `${id}-c`, ownerId: "ada", todoId: id, body: "First" })
    }
    const add = (local: SyncLocal<Todo>, { id, title }: TodoActions["add"]) => {
      const key = local.insert({ ...(id ? { id } : {}), title })
      local.sync("comments").insert({ id: `${key}-c`, todoId: key, body: "First" })
    }
    // The first tab sends its push only when the test lets it.
    let send!: () => void
    const gate = new Promise<void>((resolve) => {
      send = resolve
    })
    const one = h.open({ actions: { add }, fetch: async (input, init) => {
      if (init?.method === "POST") await gate
      return h.server.fetch(input, init)
    } }).store
    const page: SyncPage = { stores: new Set(), version: 0 }
    const two = h.open({ page, actions: { add } }).store
    const shownComments = h.open({ page, name: "comments", fetch: comments.fetch }).store
    await Promise.all([one.refresh(), two.refresh(), shownComments.refresh()])
    const shown: boolean[] = []
    shownComments.subscribe(() => shown.push(shownComments.get("t1-c") !== undefined))

    const call = one.actions.add({ id: "t1", title: "Milk" })
    await until(() => shownComments.get("t1-c") !== undefined)
    send()
    await call
    await until(() => two.getState().queued === 0 && !shownComments.pending("t1-c") && comments.requests.filter(request => request.method === "GET").length > 1)
    await until(() => shownComments.getState().status === "ready")
    expect(shownComments.get("t1-c")).toMatchObject({ body: "First" })
    expect(shown.slice(shown.indexOf(true))).not.toContain(false)
  })

  /**
   * The todos store, whose `complete` changes the comment `c1` of todo `t1` with `optimistic` in the browser and with
   * `apply` on the comments server, and a comments store for each subset.
   */
  async function commentPage(optimistic: (local: SyncLocal<Todo>) => void, apply: (comments: FakeSyncServer) => void, subsets: SyncValues[], gate?: Promise<void>) {
    const h = setup()
    const comments = createFakeSyncServer("comments")
    comments.live = false
    comments.write({ id: "c1", ownerId: "ada", todoId: "t1", body: "First" })
    h.server.actions.complete = () => apply(comments)
    // A push of todos waits for `gate`. It starts once the queue is stored.
    let pushes = 0
    const todos = h.open({ actions: { complete: optimistic }, fetch: async (input, init) => {
      if (init?.method === "POST") {
        pushes++
        await gate
      }
      return h.server.fetch(input, init)
    } }).store
    const stores = subsets.map(where => h.open({ name: "comments", fetch: comments.fetch, where }).store)
    await Promise.all([todos.refresh(), ...stores.map(store => store.refresh())])
    const pulls = (where: SyncValues) => comments.requests.filter(request => request.method === "GET" && request.url.searchParams.get("where") === JSON.stringify(where)).length
    return { h, comments, todos, stores, pulls, pushes: () => pushes }
  }

  /** The body of `c1` in `store` at each change. */
  function bodies(store: SyncStore<Todo, TodoActions>): unknown[] {
    const seen: unknown[] = []
    store.subscribe(() => {
      const row = store.get("c1")
      seen.push(row && Reflect.get(row, "body"))
    })
    return seen
  }

  it("keeps a deletion in another store until that store pulled, and pulls that store", async () => {
    const { todos, stores: [shown], pulls } = await commentPage(local => local.sync("comments").delete("c1"), comments => comments.remove("c1"), [{ todoId: "t1" }])
    const seen = bodies(shown!)
    const before = pulls({ todoId: "t1" })
    const call = todos.actions.complete({ id: "t1" })
    expect(shown!.get("c1")).toBeUndefined()
    await call
    await until(() => pulls({ todoId: "t1" }) > before)
    await shown!.refresh()
    expect(shown!.get("c1")).toBeUndefined()
    // The row never came back.
    expect(seen).not.toContain("First")
  })

  it("runs an optimistic function again on the rows of the other store without its own earlier change", async () => {
    let send!: () => void
    const gate = new Promise<void>((resolve) => {
      send = resolve
    })
    const { todos, stores: [shown], pushes } = await commentPage((local) => {
      const comment = local.sync("comments").get("c1")
      if (comment) local.sync("comments").update("c1", { body: `${comment.body}!` })
    }, (comments) => {
      const row = comments.rows.get("c1")!
      comments.write({ ...row, body: `${String(row.body)}!` })
    }, [{ todoId: "t1" }], gate)
    const seen = bodies(shown!)
    const first = todos.actions.complete({ id: "t1" })
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
    // Storing the queue builds the view of todos again, and runs the function again.
    await until(() => pushes() > 0)
    expect(todos.getState().queued).toBe(1)
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
    // A second call sees the change of the first one.
    const second = todos.actions.complete({ id: "t1" })
    expect(shown!.get("c1")).toMatchObject({ body: "First!!" })
    send()
    await Promise.all([first, second])
    await shown!.refresh()
    expect(shown!.get("c1")).toMatchObject({ body: "First!!" })
    expect(seen.filter(body => body !== "First!" && body !== "First!!")).toEqual([])
  })

  it("keeps one change of a queued action in the other store when an unrelated write rebuilds the source store", async () => {
    const gate = new Promise<void>(() => {})
    const { todos, stores: [shown] } = await commentPage((local) => {
      const comment = local.sync("comments").get("c1")
      if (comment) local.sync("comments").update("c1", { body: `${comment.body}!` })
    }, () => {}, [{ todoId: "t1" }], gate)
    void todos.actions.complete({ id: "t1" }).then(undefined, () => undefined)
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
    // Writes in the source store, which build its view again and run the optimistic function again.
    todos.insert({ title: "Unrelated" })
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
    todos.insert({ title: "Another" })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
  })

  it("keeps one change of an action queued offline in the other store when an unrelated write rebuilds the source store", async () => {
    const { h, todos, stores: [shown] } = await commentPage((local) => {
      const comment = local.sync("comments").get("c1")
      if (comment) local.sync("comments").update("c1", { body: `${comment.body}!` })
    }, () => {}, [{ todoId: "t1" }])
    h.server.offline = true
    expect(shown!.get("c1")).toMatchObject({ body: "First" })
    void todos.actions.complete({ id: "t1" }).then(undefined, () => undefined)
    await until(() => todos.getState().status === "offline")
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
    void todos.insert({ title: "Unrelated" }).then(undefined, () => undefined)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(todos.getState().queued).toBe(2)
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
  })

  it("reads the other store for an optimistic function also before anything read that store", async () => {
    const gate = new Promise<void>(() => {})
    const { todos, stores: [shown] } = await commentPage((local) => {
      const comment = local.sync("comments").get("c1")
      local.sync("comments").update("c1", { body: comment ? `${comment.body}!` : "missing" })
    }, () => {}, [{ todoId: "t1" }], gate)
    void todos.actions.complete({ id: "t1" }).then(undefined, () => undefined)
    todos.insert({ title: "Unrelated" })
    expect(shown!.get("c1")).toMatchObject({ body: "First!" })
  })

  it("moves a row between the stores of two subsets when a linked update changes the subset column", async () => {
    const { todos, stores: [first, second], pulls } = await commentPage(local => local.sync("comments").update("c1", { todoId: "t2" }), (comments) => {
      comments.write({ ...comments.rows.get("c1")!, todoId: "t2" })
    }, [{ todoId: "t1" }, { todoId: "t2" }])
    const seen = bodies(second!)
    const before = [pulls({ todoId: "t1" }), pulls({ todoId: "t2" })]
    const call = todos.actions.complete({ id: "t1" })
    expect(first!.get("c1")).toBeUndefined()
    expect(second!.get("c1")).toMatchObject({ id: "c1", todoId: "t2", body: "First" })
    expect(second!.pending("c1")).toBe(true)
    await call
    // Both stores showed the change, so both pull.
    await until(() => pulls({ todoId: "t1" }) > before[0]! && pulls({ todoId: "t2" }) > before[1]!)
    await Promise.all([first!.refresh(), second!.refresh()])
    expect(first!.get("c1")).toBeUndefined()
    expect(second!.get("c1")).toMatchObject({ todoId: "t2", body: "First" })
    expect(seen).not.toContain(undefined)
  })
})

describe("coalescing and pending", () => {
  it("sends the writes of one tick in one push, and merges a patch into the update that waits", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }, { id: "b", ownerId: "ada", title: "Eggs" }])
    const { store } = h.open()
    await store.refresh()
    const first = store.update("a", { title: "Oat milk" })
    const second = store.update("a", { done: true })
    store.update("b", { title: "Brown eggs" })
    const third = store.update("a", { title: "Soy milk" })
    expect(store.get("a")).toMatchObject({ title: "Soy milk", done: true })
    expect(store.getState().queued).toBe(2)
    await Promise.all([first, second, third])
    expect(posts(h)).toHaveLength(1)
    expect(posts(h)[0]!.body!.mutations).toEqual([
      { id: expect.any(String), op: "update", key: "b", patch: { title: "Brown eggs" } },
      { id: expect.any(String), op: "update", key: "a", patch: { title: "Soy milk", done: true } },
    ])
    expect(await first).toMatchObject({ title: "Soy milk", done: true })
  })

  it("never merges into an update that is on its way to the server", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { store } = h.open({
      fetch: async (input, init) => {
        if (init?.method === "POST") await gate
        return h.server.fetch(input, init)
      },
    })
    await store.refresh()
    store.update("a", { title: "Oat milk" })
    await until(() => h.server.requests.length > 1 || posts(h).length > 0 || store.getState().queued === 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    store.update("a", { title: "Soy milk" })
    expect(store.getState().queued).toBe(2)
    release()
    await until(() => store.getState().queued === 0)
    expect(h.server.applied.map(mutation => mutation.op === "update" && mutation.patch.title)).toEqual(["Oat milk", "Soy milk"])
  })

  it("never merges into an update that was sent and whose answer was lost", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const { store } = h.open()
    await store.refresh()
    // The server applies the update, but the answer does not arrive.
    h.server.loseNextResponse = true
    const first = store.update("a", { title: "first" })
    await until(() => store.getState().status === "offline")
    expect(h.server.rows.get("a")?.title).toBe("first")
    // Another device changes the title after it.
    h.server.write({ id: "a", ownerId: "ada", title: "newer", done: false })
    const second = store.update("a", { done: true })
    await store.refresh()
    await Promise.all([first, second])
    expect(h.server.rows.get("a")).toMatchObject({ title: "newer", done: true })
    expect(store.get("a")).toMatchObject({ title: "newer", done: true })
    const stored = await h.storage.readQueue("/_vitehub/sync/todos")
    expect(stored.writes).toEqual([])
  })

  it("never merges into an update that another tab sent", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const one = h.open()
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    h.server.loseNextResponse = true
    const first = one.store.update("a", { title: "first" })
    first.then(undefined, () => undefined)
    // The other tab reads the update before the first tab sends it.
    await until(() => two.store.pending("a"))
    await until(() => one.store.getState().status === "offline")
    expect(h.server.rows.get("a")?.title).toBe("first")
    h.server.write({ id: "a", ownerId: "ada", title: "newer", done: false })
    const second = two.store.update("a", { done: true })
    await second.then(undefined, () => undefined)
    await Promise.all([two.store.refresh(), one.store.refresh()])
    await until(() => one.store.getState().queued === 0 && two.store.getState().queued === 0)
    expect(h.server.rows.get("a")).toMatchObject({ title: "newer", done: true })
    expect(h.server.applied.filter(mutation => mutation.op === "update").map(mutation => mutation.op === "update" && mutation.patch)).toEqual([{ title: "first" }, { done: true }])
  })

  it("never replaces an update of another tab, so that tab's handle waits for the server", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const one = h.open()
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    h.server.offline = true
    await Promise.all([one.store.refresh(), two.store.refresh()])
    const first = one.store.update("a", { title: "Oat milk" })
    await until(() => two.store.pending("a"))
    const second = two.store.update("a", { done: true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(first.state).toBe("queued")
    h.server.offline = false
    await Promise.all([one.store.refresh(), two.store.refresh()])
    expect(await first).toMatchObject({ title: "Oat milk" })
    expect(await second).toMatchObject({ title: "Oat milk", done: true })
    expect(h.server.applied.map(mutation => mutation.op === "update" && mutation.patch)).toEqual([{ title: "Oat milk" }, { done: true }])
  })

  it("never merges over a newer update of the same row that another tab stored", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk", done: false }])
    const one = h.open()
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    h.server.offline = true
    await Promise.all([one.store.refresh(), two.store.refresh()])
    // The tabs do not hear each other, as when BroadcastChannel is late.
    const tabs = [...h.bus.tabs]
    h.bus.tabs.clear()
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    void one.store.update("a", { title: "Oat milk" }).then(undefined, () => undefined)
    await tick()
    void two.store.update("a", { title: "Soy milk" }).then(undefined, () => undefined)
    await tick()
    void one.store.update("a", { done: true }).then(undefined, () => undefined)
    await tick()
    for (const tab of tabs) h.bus.tabs.add(tab)
    h.server.offline = false
    await Promise.all([one.store.refresh(), two.store.refresh()])
    await until(() => one.store.getState().queued === 0 && two.store.getState().queued === 0)
    expect(h.server.rows.get("a")).toMatchObject({ title: "Soy milk", done: true })
  })

  it("tells which rows have queued writes", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }, { id: "b", ownerId: "ada", title: "Eggs" }])
    const { store } = h.open()
    await store.refresh()
    h.server.refuse = () => ({ code: "SYNC_INVALID", message: "No." })
    const write = store.update("a", { title: "Oat milk" })
    expect([store.pending("a"), store.pending("b")]).toEqual([true, false])
    await write.then(undefined, () => undefined)
    // A refused write is a failure, not a queued write.
    expect(store.pending("a")).toBe(false)
  })
})

describe("live", () => {
  function live(): Harness {
    const h = setup()
    h.server.live = true
    return h
  }

  /** Runs the timers of the tab, such as the pause before the stream opens again, until every store is in one stream. */
  async function liveInOneStream(h: Harness, tab: Tab[]): Promise<void> {
    await until(() => {
      tab[0]!.browser.fire()
      return tab.every(({ store }) => store.getState().live) && h.server.streams === 1
    })
  }

  const listsOf = (h: Harness) => streams(h).at(-1)!.live!.pulls.map(pull => pull.where?.listId).sort()

  it("streams the six stores of a tab in one stream, and gives each store its own changes", async () => {
    const h = live()
    const first = h.open({ where: { listId: "l0" } })
    const tab = [first, ...Array.from({ length: 5 }, (_, index) => h.open({ tab: first, where: { listId: `l${index + 1}` } }))]
    await Promise.all(tab.map(({ store }) => store.refresh()))
    await liveInOneStream(h, tab)
    expect(listsOf(h)).toEqual(["l0", "l1", "l2", "l3", "l4", "l5"])
    // The first store opens the stream at once. The stores that join it later open it again once, after a pause.
    expect(streams(h).length).toBeLessThanOrEqual(2)
    h.server.write({ id: "x", ownerId: "ada", listId: "l3", title: "Only in l3" })
    await until(() => tab[3]!.store.get("x") !== undefined)
    expect(tab.filter(({ store }) => store.get("x")).length).toBe(1)
    expect(h.server.streams).toBe(1)
  })

  it("opens the stream of the tab again when a store joins or leaves, and closes it after the last one", async () => {
    const h = live()
    const one = h.open({ where: { listId: "a" } })
    const two = h.open({ tab: one, where: { listId: "b" } })
    await Promise.all([one.store.refresh(), two.store.refresh()])
    await liveInOneStream(h, [one, two])
    const opened = streams(h).length

    const three = h.open({ tab: one, where: { listId: "c" } })
    await three.store.refresh()
    // The open stream stays until the pause ends, so the stores in it stay live.
    await until(() => one.browser.timers.length === 1)
    expect(h.server.streams).toBe(1)
    expect(one.store.getState().live).toBe(true)
    one.browser.fire()
    await liveInOneStream(h, [one, two, three])
    expect(streams(h)).toHaveLength(opened + 1)
    expect(listsOf(h)).toEqual(["a", "b", "c"])

    two.store.destroy()
    await until(() => one.browser.timers.length === 1)
    one.browser.fire()
    await liveInOneStream(h, [one, three])
    expect(streams(h)).toHaveLength(opened + 2)
    expect(listsOf(h)).toEqual(["a", "c"])

    one.store.destroy()
    three.store.destroy()
    await until(() => h.server.streams === 0)
    expect(one.browser.timers).toEqual([])
  })

  it("shows the stores of a stream as not live while a new stream with another store opens", async () => {
    const h = live()
    let opened = 0
    let release = () => {}
    const waiting = new Promise<void>(resolve => release = resolve)
    // The second stream, with both stores, answers only after `release()`.
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (isLive(input) && ++opened === 2) await waiting
      return await h.server.fetch(input, init)
    }
    const one = h.open({ fetch, interval: 30_000, where: { listId: "a" } })
    await one.store.refresh()
    await until(() => one.store.getState().live)
    expect(one.browser.timers.map(timer => timer.ms)).toEqual([300_000])

    const two = h.open({ tab: one, fetch, interval: 30_000, where: { listId: "b" } })
    await two.store.refresh()
    await until(() => one.browser.timers.some(timer => timer.ms === 100))
    const pause = one.browser.timers.find(timer => timer.ms === 100)!
    one.browser.timers.splice(one.browser.timers.indexOf(pause), 1)
    pause.task()
    await until(() => opened === 2)
    // The first stream is gone, and the new one is not open yet: no store is live, and each pulls at its own interval.
    expect(h.server.streams).toBe(0)
    expect(one.store.getState().live).toBe(false)
    expect(one.browser.timers.map(timer => timer.ms)).toEqual([30_000, 30_000])

    release()
    await until(() => one.store.getState().live && two.store.getState().live)
    expect(h.server.streams).toBe(1)
    expect(one.browser.timers.map(timer => timer.ms)).toEqual([300_000, 300_000])
  })

  it("shows the stores as not live while the stream waits for the backoff to open again", async () => {
    const h = live()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }])
    const encoder = new TextEncoder()
    let send: (pull: object) => void = () => undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!isLive(input)) return await h.server.fetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: open\ndata: {}\n\n"))
          send = pull => controller.enqueue(encoder.encode(`event: pull\ndata: ${JSON.stringify({ name: "todos", pull })}\n\n`))
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const { store, browser } = h.open({ fetch, interval: 30_000 })
    await store.refresh()
    await until(() => store.getState().live)
    expect(browser.timers.map(timer => timer.ms)).toEqual([300_000])
    // A pull of another account: the store pulls, and the stream opens again after the backoff.
    send({ key: "id", scope: { id: scopeIdOf({ name: "todos", ownerId: "bob" }), values: { ownerId: "bob" } }, account: accountOf("bob"), version: "v1", defaults: {}, cursor: 2, reset: false, rows: [], deleted: [], more: false })
    await until(() => browser.timers.length === 2)
    expect(store.getState().live).toBe(false)
    // The backoff, and the interval pull at its own rate again.
    expect(browser.timers.map(timer => timer.ms)).toContain(30_000)
    expect(browser.timers.map(timer => timer.ms)).not.toContain(300_000)
    browser.fire()
    await until(() => store.getState().live)
    expect(browser.timers.map(timer => timer.ms)).toEqual([300_000])
  })

  it("keeps the other stores live when the server refuses one store of the stream", async () => {
    const h = live()
    let teams = ["red", "blue"]
    h.server.where = () => ({ teamId: teams })
    const red = h.open({ where: { teamId: "red" } })
    const blue = h.open({ tab: red, where: { teamId: "blue" } })
    await Promise.all([red.store.refresh(), blue.store.refresh()])
    await liveInOneStream(h, [red, blue])
    // Ada leaves the blue team. The next stream refuses the blue store alone.
    teams = ["red"]
    h.server.endStreams()
    await until(() => red.browser.timers.length === 1)
    red.browser.fire()
    await until(() => blue.store.getState().status === "error")
    expect(blue.store.getState()).toMatchObject({ live: false, error: { code: "SYNC_OUT_OF_SCOPE" } })
    await until(() => red.store.getState().live && h.server.streams === 1)
    h.server.write({ id: "r1", ownerId: "ada", teamId: "red", title: "Still live" })
    await until(() => red.store.get("r1") !== undefined)
  })

  it("opens one stream after the first pull and shows other people's changes without a pull", async () => {
    const h = live()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store } = h.open({ interval: 30_000 })
    await store.refresh()
    await until(() => store.getState().live)
    expect(streams(h)[0]!.live!.pulls).toEqual([{ name: "todos", cursor: 1, scope: scopeIdOf({ name: "todos", ownerId: "ada" }), version: "v1", paged: true }])
    const count = pulls(h).length
    h.server.write({ id: "b", ownerId: "ada", title: "Eggs" })
    h.server.write({ id: "c", ownerId: "bob", title: "Not mine" })
    h.server.remove("a")
    await until(() => store.getState().rows.length === 1 && store.getState().rows[0]!.id === "b")
    expect(pulls(h).length).toBe(count)
  })

  it("slows the interval pull while live, and closes the stream when the page hides", async () => {
    const h = live()
    const { store, browser } = h.open({ interval: 30_000 })
    await store.refresh()
    await until(() => store.getState().live)
    expect(browser.timers.map(timer => timer.ms)).toEqual([300_000])
    browser.emit("hidden")
    await until(() => h.server.streams === 0)
    expect(store.getState().live).toBe(false)
    expect(browser.timers.map(timer => timer.ms)).toEqual([30_000])
    browser.emit("visible")
    await until(() => store.getState().live)
    expect(streams(h)).toHaveLength(2)
  })

  it("opens a new stream when the server ends one, and stops after a 400", async () => {
    const h = live()
    const { store, browser } = h.open()
    await store.refresh()
    await until(() => store.getState().live)
    h.server.endStreams()
    // The stream ended at once, so the next one waits for the backoff timer.
    await until(() => !store.getState().live && browser.timers.length === 1)
    browser.fire()
    await until(() => store.getState().live)
    h.server.live = false
    h.server.endStreams()
    await until(() => browser.timers.length === 1)
    browser.fire()
    await until(() => streams(h).length === 3 && !store.getState().live)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(browser.timers).toEqual([])
    browser.emit("visible")
    await store.refresh()
    expect(streams(h)).toHaveLength(3)
  })

  it("streams in one tab, and the other tab gets the changes from it", async () => {
    const h = live()
    const one = h.open()
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    await until(() => one.store.getState().live || two.store.getState().live)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.server.streams).toBe(1)
    const [leader, other] = one.store.getState().live ? [one, two] : [two, one]
    h.server.write({ id: "a", ownerId: "ada", title: "From the server" })
    await until(() => other.store.getState().rows.length === 1)
    // The leader hides, and the other tab takes over the stream.
    leader.browser.emit("hidden")
    await until(() => other.store.getState().live)
    expect(h.server.streams).toBe(1)
  })

  it("pulls after an error event, so the store shows why the stream ended", async () => {
    const h = live()
    let refuse = false
    const refusal = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ name: "todos", error: { code: "SYNC_UNAUTHORIZED", message: "Sign in." } })}\n\n`))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
    const { store, browser } = h.open({ fetch: async (input, init) => refuse && isLive(input) ? refusal() : h.server.fetch(input, init) })
    await store.refresh()
    await until(() => store.getState().live)
    // The person signs out in another tab. The next stream gets an error event.
    h.server.user = null
    refuse = true
    h.server.endStreams()
    await until(() => browser.timers.length === 1)
    browser.fire()
    await until(() => store.getState().status === "error")
    expect(store.getState()).toMatchObject({ live: false, error: { code: "SYNC_UNAUTHORIZED" } })
  })

  it("applies a streamed pull only on top of its cursor, and pulls instead when it is older than the rows", async () => {
    const h = live()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const encoder = new TextEncoder()
    let send: (pull: object) => void = () => undefined
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!isLive(input)) return h.server.fetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: open\ndata: {}\n\n"))
          send = pull => controller.enqueue(encoder.encode(`event: pull\ndata: ${JSON.stringify({ name: "todos", pull })}\n\n`))
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const { store } = h.open({ fetch })
    await store.refresh()
    await until(() => store.getState().live)
    const base = { key: "id", scope: { id: scopeIdOf({ name: "todos", ownerId: "ada" }), values: { ownerId: "ada" } }, account: accountOf("ada"), version: "v1", defaults: {}, reset: false, deleted: [], more: false }

    // On top of the local cursor 1: applied.
    h.server.write({ id: "b", ownerId: "ada", title: "Eggs" })
    send({ ...base, cursor: 2, rows: [{ id: "b", ownerId: "ada", title: "Eggs" }] })
    await until(() => store.get("b") !== undefined)
    const count = pulls(h).length

    // A pull moved the local cursor past the stream: the streamed pull brings nothing new.
    h.server.write({ id: "b", ownerId: "ada", title: "Brown eggs" })
    await store.refresh()
    send({ ...base, cursor: 3, rows: [{ id: "b", ownerId: "ada", title: "Stale eggs" }] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.get("b")?.title).toBe("Brown eggs")
    expect(pulls(h).length).toBe(count + 1)

    // The stream starts below the local cursor and ends past it: the store pulls instead.
    h.server.write({ id: "b", ownerId: "ada", title: "Fresh eggs" })
    await store.refresh()
    h.server.write({ id: "c", ownerId: "ada", title: "Bread" })
    send({ ...base, cursor: 99, rows: [{ id: "b", ownerId: "ada", title: "Stale eggs" }] })
    await until(() => store.get("c") !== undefined)
    expect(store.get("b")?.title).toBe("Fresh eggs")
    expect(pulls(h).length).toBe(count + 3)
  })
})

describe("live streams of an old account or scope", () => {
  function live(): Harness {
    const h = setup()
    h.server.live = true
    return h
  }

  it("drops a pull of the stream of the previous account, at the same cursor", async () => {
    const h = live()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const { store } = h.open()
    await store.refresh()
    await until(() => store.getState().live)
    const cursor = streams(h)[0]!.live!.pulls[0]!.cursor

    // Bob signs in. The pull resets to his rows at the same cursor, while Ada's stream is still open.
    h.server.user = "bob"
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual(["b"])
    expect(Number(pulls(h).at(-1)!.url.searchParams.get("cursor"))).toBe(cursor)

    // Server code changes a row of Ada. Her stream would bring it on top of Bob's cursor.
    h.server.write({ id: "c", ownerId: "ada", title: "Ada's private" })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.getState().rows.map(row => row.id)).toEqual(["b"])
    await until(() => store.getState().live && h.server.streams === 1)
    expect(streams(h)).toHaveLength(2)

    // The new stream is Bob's, and a write after it goes out with his account.
    h.server.write({ id: "d", ownerId: "bob", title: "Bob's new" })
    await until(() => store.get("d") !== undefined)
    await store.insert({ title: "Bob's write" })
    expect(posts(h).at(-1)!.body!.account).toBe(accountOf("bob"))
  })

  it("drops the rows of a team that the caller left, after the store moved to another team", async () => {
    const h = live()
    let teams = ["red"]
    h.server.where = () => ({ teamId: teams })
    seed(h, [{ id: "r1", ownerId: "ada", teamId: "red", title: "Red" }, { id: "b1", ownerId: "ada", teamId: "blue", title: "Blue" }])
    const { store } = h.open()
    await store.refresh()
    await until(() => store.getState().live)
    expect(store.getState().rows.map(row => row.id)).toEqual(["r1"])

    // Ada leaves the red team and joins the blue one. The account stays, the scope changes.
    teams = ["blue"]
    await store.refresh()
    expect(store.getState().rows.map(row => row.id)).toEqual(["b1"])
    h.server.write({ id: "r2", ownerId: "ada", teamId: "red", title: "Red private" })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.getState().rows.map(row => row.id)).toEqual(["b1"])
    h.server.write({ id: "b2", ownerId: "ada", teamId: "blue", title: "Blue new" })
    await until(() => store.get("b2") !== undefined)
    expect(store.getState().rows.map(row => row.id)).toEqual(["b1", "b2"])
  })

  it("ends a stream whose pull has another account, and pulls instead", async () => {
    const h = live()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }])
    const encoder = new TextEncoder()
    let send: (pull: object) => void = () => undefined
    let opened = 0
    let cancelled = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!isLive(input)) return h.server.fetch(input, init)
      opened++
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: open\ndata: {}\n\n"))
          send = pull => controller.enqueue(encoder.encode(`event: pull\ndata: ${JSON.stringify({ name: "todos", pull })}\n\n`))
        },
        cancel() {
          cancelled++
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const { store, browser } = h.open({ fetch })
    await store.refresh()
    await until(() => store.getState().live)
    const count = pulls(h).length
    // A proxy reuses a stream of another session: its pull is on top of the local cursor, but for Bob.
    send({ key: "id", scope: { id: scopeIdOf({ name: "todos", ownerId: "bob" }), values: { ownerId: "bob" } }, account: accountOf("bob"), version: "v1", defaults: {}, cursor: 2, reset: false, rows: [{ id: "x", ownerId: "bob", title: "Bob's" }], deleted: [], more: false })
    // The pull still says Ada, so the next stream waits for backoff.
    await until(() => pulls(h).length > count && browser.timers.length === 1)
    expect(cancelled).toBe(1)
    browser.fire()
    await until(() => opened === 2 && store.getState().live)
    expect(store.get("x")).toBeUndefined()
    expect(store.getState().rows.map(row => row.id)).toEqual(["a"])
  })
})

describe("persistence and tabs", () => {
  it("keeps an offline insert after a reload, and sends it when online (farm.js: lost queue)", async () => {
    const h = setup()
    const first = h.open()
    await first.store.refresh()
    h.server.offline = true
    first.browser.emit("offline")
    const write = first.store.insert({ title: "Milk" })
    write.then(undefined, () => undefined)
    await first.store.refresh()
    first.store.destroy()

    const second = h.open()
    await until(() => second.store.getState().queued === 1)
    expect(second.store.getState().rows).toMatchObject([{ id: write.key, title: "Milk", ownerId: "ada" }])
    expect(second.store.getState().persisted).toBe(false)
    h.server.offline = false
    second.browser.emit("online")
    await second.store.refresh()
    expect(second.store.getState()).toMatchObject({ queued: 0, rows: [{ id: write.key, title: "Milk" }] })
    expect(h.server.applied).toHaveLength(1)
  })

  it("sends a write that the store took just before destroy()", async () => {
    const h = setup()
    const first = h.open()
    await first.store.refresh()
    const write = first.store.insert({ title: "Milk" })
    first.store.destroy()
    expect(await write).toMatchObject({ title: "Milk", ownerId: "ada" })
    expect(h.server.rows.get(write.key)).toMatchObject({ title: "Milk", ownerId: "ada" })
    expect((await h.storage.readQueue("/_vitehub/sync/todos")).writes).toEqual([])
  })

  it("keeps sending the queue of a destroyed store until it is empty, as after a navigation while offline", async () => {
    const h = setup()
    const { store, browser } = h.open()
    await store.refresh()
    h.server.offline = true
    const write = store.insert({ title: "Milk" })
    await until(() => store.getState().status === "offline")
    store.destroy()
    h.server.offline = false
    // The backoff timer of the failed push fires.
    browser.fire()
    expect(await write).toMatchObject({ title: "Milk", ownerId: "ada" })
    expect((await h.storage.readQueue("/_vitehub/sync/todos")).writes).toEqual([])
    const requests = h.server.requests.length
    expect(browser.fire()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.server.requests.length).toBe(requests)
  })

  it("pulls before a destroyed store decides that it has nothing to send, as when another account was cached", async () => {
    const h = setup()
    const first = h.open()
    await first.store.refresh()
    h.server.offline = true
    const write = first.store.insert({ title: "Ada's" })
    write.then(undefined, () => undefined)
    await until(() => first.store.getState().status === "offline")
    // Bob signs in, so the stored copy now has Bob's account. Ada's write waits.
    h.server.user = "bob"
    h.server.offline = false
    await first.store.refresh()
    first.store.destroy()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.server.applied).toEqual([])
    // Ada is back, and the page sends the stored writes with a store that it destroys at once.
    h.server.user = "ada"
    h.open().store.destroy()
    await until(() => h.server.rows.has(write.key))
    expect(h.server.rows.get(write.key)).toMatchObject({ title: "Ada's", ownerId: "ada" })
  })

  it("stops a destroyed store with an empty queue at once, also offline", async () => {
    const h = setup()
    h.server.offline = true
    const { store, browser } = h.open()
    store.destroy()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.server.requests).toEqual([])
    expect(browser.timers).toEqual([])
  })

  it("shows in an open store the writes that a destroyed store sent", async () => {
    const h = setup()
    const other = h.open()
    const first = h.open()
    await Promise.all([other.store.refresh(), first.store.refresh()])
    // A component unmounts, or moves to another subset, in the tick of its write.
    const write = first.store.insert({ title: "Eggs" })
    first.store.destroy()
    await until(() => h.server.rows.has(write.key))
    await until(() => other.store.getState().queued === 0 && other.store.get(write.key) !== undefined)
  })

  it("keeps a write made before the stored copy is read with the stored account", async () => {
    const h = setup()
    const first = h.open()
    await first.store.refresh()
    first.store.destroy()
    h.server.offline = true
    // A new page: the write comes before the store has read its stored copy.
    const { store } = h.open()
    const insert = store.insert({ title: "Ada's" })
    insert.then(undefined, () => undefined)
    await store.refresh()
    h.server.user = "bob"
    h.server.offline = false
    await store.refresh()
    expect(h.server.applied).toEqual([])
    expect(insert.state).toBe("queued")
    h.server.user = "ada"
    await store.refresh()
    expect(await insert).toMatchObject({ title: "Ada's", ownerId: "ada" })
  })

  it("keeps an insert made before the first pull, and sends it with the scope of that pull", async () => {
    const h = setup()
    h.server.offline = true
    const { store } = h.open()
    const write = store.insert({ title: "Milk" })
    expect(store.getState().rows).toMatchObject([{ id: write.key, title: "Milk" }])
    h.server.offline = false
    await store.refresh()
    expect(await write).toEqual({ id: write.key, ownerId: "ada", title: "Milk" })
  })

  it("shows the writes of another tab, and sends each write once", async () => {
    const h = setup()
    const one = h.open()
    const two = h.open()
    await Promise.all([one.store.refresh(), two.store.refresh()])
    const write = one.store.insert({ title: "Milk" })
    await until(() => two.store.getState().rows.length === 1)
    await write
    await Promise.all([one.store.refresh(), two.store.refresh()])
    await until(() => two.store.getState().queued === 0)
    expect(two.store.getState().rows).toMatchObject([{ id: write.key, title: "Milk" }])
    expect(h.server.applied).toHaveLength(1)
    expect(posts(h).flatMap(post => post.body!.mutations)).toHaveLength(1)
  })
})

describe("freshness", () => {
  it("pulls when the page becomes visible and when the network comes back", async () => {
    const h = setup()
    const { store, browser } = h.open()
    await store.refresh()
    const before = pulls(h).length
    browser.emit("visible")
    await until(() => pulls(h).length === before + 1)
    browser.emit("online")
    await until(() => pulls(h).length === before + 2)
  })

  it("pulls on the interval only while the page is visible", async () => {
    const h = setup()
    const { store, browser } = h.open({ interval: 30_000 })
    await store.refresh()
    const before = pulls(h).length
    expect(browser.fire()).toContain(30_000)
    await until(() => pulls(h).length === before + 1)
    await store.refresh()
    const count = pulls(h).length
    browser.visible = false
    browser.fire()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(pulls(h).length).toBe(count)
  })

  it("backs off with jitter on a server error, and retries at once when the network comes back", async () => {
    const h = setup()
    const { store, browser } = h.open()
    await store.refresh()
    h.server.failWith = 503
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "error", error: { code: "SYNC_SERVER_ERROR", status: 503 } })
    const first = browser.timers.map(timer => timer.ms)
    expect(first).toHaveLength(1)
    expect(first[0]).toBeGreaterThanOrEqual(500)
    expect(first[0]).toBeLessThanOrEqual(1000)
    browser.fire()
    await until(() => browser.timers.length === 1)
    expect(browser.timers[0]!.ms).toBeGreaterThan(first[0]!)
    // A write waits for the timer instead of calling a failing server at once.
    const requests = h.server.requests.length
    store.insert({ title: "Milk" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.server.requests.length).toBe(requests)
    h.server.failWith = undefined
    browser.emit("online")
    await until(() => store.getState().queued === 0)
    expect(browser.timers).toEqual([])
  })
})

describe("startup scope and paged acknowledgments", () => {
  it.each(["insert", "update", "delete"] as const)("binds an immediate %s to the cached account", async (op) => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const first = h.open().store
    await first.refresh()
    first.destroy()
    h.server.offline = true
    const { store } = h.open()
    const write = op === "insert" ? store.insert({ title: "Eggs" }) : op === "update" ? store.update("a", { title: "Eggs" }) : store.delete("a")
    await store.refresh()
    h.server.user = "bob"
    h.server.offline = false
    await store.refresh()
    expect(write.state).toBe("queued")
    expect(store.getState().queued).toBe(0)
    expect(posts(h)).toHaveLength(0)
    h.server.user = "ada"
    await store.refresh()
    await write
    expect(h.server.applied).toHaveLength(1)
  })

  it.each(["insert", "update", "delete"] as const)("keeps a paged %s optimistic until its confirmed result arrives", async (op) => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }])
    const { store } = h.open()
    await store.refresh()
    for (let i = 0; i < 500; i++) h.server.write({ id: `remote-${i}`, ownerId: "ada", title: "Remote" })
    const write = op === "insert" ? store.insert({ title: "Eggs" }) : op === "update" ? store.update("a", { title: "Eggs" }) : store.delete("a")
    const observed: unknown[] = []
    const stop = store.subscribe(() => observed.push(store.get(write.key)?.title))
    const row = await write
    stop()
    expect(row?.title).toBe(op === "delete" ? undefined : "Eggs")
    expect(observed.every(title => title === (op === "delete" ? undefined : "Eggs"))).toBe(true)
    expect(pulls(h).length).toBeGreaterThan(1)
  })
})
