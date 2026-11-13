import { afterEach, describe, expect, it } from "vitest"

import { createMemoryStorage } from "../src/client/storage.ts"
import { SyncError } from "../src/client/types.ts"
import { scopeIdOf } from "./client-fake-server.ts"
import { createHarness, until } from "./client-harness.ts"

import type { SyncStorage } from "../src/client/storage.ts"
import type { Harness, Todo } from "./client-harness.ts"

let harness: Harness

afterEach(() => harness?.close())

function setup(): Harness {
  harness = createHarness()
  return harness
}

function seed(h: Harness, rows: Todo[]): void {
  for (const row of rows) h.server.write({ ...row })
}

const posts = (h: Harness) => h.server.requests.filter(request => request.method === "POST")
const pulls = (h: Harness) => h.server.requests.filter(request => request.method === "GET")

describe("start and pull", () => {
  it("pulls the caller's rows on start and shows them", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Milk" }, { id: "b", ownerId: "bob", title: "Not mine" }])
    const { store } = h.open()
    expect(store.getState().status).toBe("loading")
    await store.refresh()
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
    expect([last.get("cursor"), last.get("scope")]).toEqual(["2", scopeIdOf("ada")])
    expect(store.getState().rows.map(row => [row.id, row.title])).toEqual([["a", "Oat milk"], ["c", "Bread"]])
    expect(store.get("a")?.title).toBe("Oat milk")
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
        if (init?.method === "POST") log.push("send")
        return h.server.fetch(input, init)
      },
    })
    await store.refresh()
    const write = store.insert({ title: "Milk" })
    await store.refresh()
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

  it("applies two updates of one row in order (farm.js: writes raced)", async () => {
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
    expect(h.server.applied.map(mutation => mutation.op === "update" && mutation.patch.title)).toEqual(["Oat milk", "Soy milk"])
    expect(h.server.rows.get("a")?.title).toBe("Soy milk")
    expect(store.getState()).toMatchObject({ queued: 0, rows: [{ id: "a", title: "Soy milk" }] })
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

describe("scope guard", () => {
  it("never sends writes queued for one account after a switch (farm.js: wrong cookies)", async () => {
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
    await expect(insert).rejects.toMatchObject({ code: "SYNC_SCOPE_CHANGED" })
    await store.refresh()
    expect(h.server.applied).toEqual([])
    expect(h.server.rows.get("a")?.title).toBe("Ada's")
    expect([...h.server.rows.values()].some(row => row.title === "Ada's secret")).toBe(false)
    const state = store.getState()
    expect(state.rows.map(row => row.id)).toEqual(["b"])
    expect(state.queued).toBe(0)
    expect(state.failures.map(failure => failure.error.code)).toEqual(["SYNC_SCOPE_CHANGED", "SYNC_SCOPE_CHANGED"])

    // Nothing is sent later, also not after a retry.
    const sent = posts(h).length
    store.retry(state.failures[0]!)
    await store.refresh()
    expect(posts(h).length).toBe(sent)
    expect(h.server.applied).toEqual([])
    expect(store.getState().failures).toHaveLength(2)
  })

  it("fails the writes of a push that the server answers with 409, and pulls the new scope", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const { store } = h.open()
    await store.refresh()
    // The session changes without an event that makes the store pull first.
    h.server.user = "bob"
    const write = store.insert({ title: "Ada's secret" })
    await expect(write).rejects.toMatchObject({ code: "SYNC_SCOPE_CHANGED" })
    await until(() => store.getState().rows.length === 1 && store.getState().rows[0]!.id === "b")
    expect(posts(h).map(post => post.body!.scope)).toEqual([scopeIdOf("ada")])
    expect(h.server.applied).toEqual([])
    expect(store.getState()).toMatchObject({ queued: 0, failures: [{ error: { code: "SYNC_SCOPE_CHANGED" } }] })
  })

  it("drops old rows and fails old writes when a pull shows another scope", async () => {
    const h = setup()
    seed(h, [{ id: "a", ownerId: "ada", title: "Ada's" }, { id: "b", ownerId: "bob", title: "Bob's" }])
    const { store } = h.open()
    await store.refresh()
    h.server.offline = true
    store.insert({ title: "Ada's secret" }).then(undefined, () => undefined)
    await store.refresh()
    store.destroy()

    // A reload signed in as Bob reads the stored writes, then pulls before anything is sent.
    h.server.offline = false
    h.server.user = "bob"
    const blocked: typeof fetch = async (input, init) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch")
      return h.server.fetch(input, init)
    }
    const reload = h.open({ fetch: blocked })
    await reload.store.refresh()
    expect(reload.store.getState().rows.map(row => row.id)).toEqual(["b"])
    expect(reload.store.getState().failures.map(failure => failure.error.code)).toEqual(["SYNC_SCOPE_CHANGED"])
    expect(posts(h)).toEqual([])
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
