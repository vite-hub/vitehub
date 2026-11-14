// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"

import { clearSync, createSync } from "../src/client.ts"
import { createFakeSyncServer } from "./client-fake-server.ts"
import { until } from "./client-harness.ts"

const stores: { destroy: () => void }[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.destroy()
  await clearSync()
})

function open(fetch: typeof globalThis.fetch, baseURL?: string) {
  const store = createSync("todos", { fetch, interval: false, ...(baseURL ? { baseURL } : {}) })
  stores.push(store)
  return store
}

describe("createSync in the browser", () => {
  it("falls back to memory without IndexedDB, and calls the route below the base URL", async () => {
    const server = createFakeSyncServer()
    server.write({ id: "a", ownerId: "ada", title: "Milk" })
    const urls: string[] = []
    const store = open(async (input, init) => {
      urls.push(String(input))
      return server.fetch(String(input).replace("/docs", ""), init)
    }, "/docs/")
    await store.refresh()
    expect(store.getState()).toMatchObject({ status: "ready", persisted: false, rows: [{ id: "a" }] })
    expect(urls[0]).toBe("/docs/api/_vitehub/sync/todos")
  })

  it("shares one store for one name, until the last user destroys it", async () => {
    const server = createFakeSyncServer()
    const one = open(server.fetch)
    const two = open(server.fetch)
    await one.refresh()
    const write = one.insert({ title: "Milk" })
    expect(two.getState().rows).toMatchObject([{ id: write.key }])
    await write
    one.destroy()
    const requests = server.requests.length
    await two.refresh()
    expect(server.requests.length).toBe(requests + 1)
    expect(() => one.insert({ title: "Late" })).toThrow("destroyed")
  })

  it("sends the writes of a subset that no component shows when the network comes back", async () => {
    const server = createFakeSyncServer()
    server.offline = true
    const list = createSync("todos", { fetch: server.fetch, interval: false, where: { listId: "l1" } })
    const write = list.insert({ title: "Milk" })
    write.then(undefined, () => undefined)
    await until(() => list.getState().status === "offline")
    // The page leaves the list while offline, and shows another table.
    list.destroy()
    open(server.fetch)
    server.offline = false
    window.dispatchEvent(new Event("online"))
    await until(() => server.rows.has(write.key))
    expect(server.rows.get(write.key)).toMatchObject({ title: "Milk", listId: "l1", ownerId: "ada" })
  })

  it("stops a destroyed store that still sends on clearSync(), so a late answer does not bring the rows back", async () => {
    const server = createFakeSyncServer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let posted = false
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        posted = true
        await gate
      }
      return server.fetch(input, init)
    }
    const list = createSync("todos", { fetch, interval: false, where: { listId: "l2" } })
    await list.refresh()
    const write = list.insert({ title: "Ada's" })
    write.then(undefined, () => undefined)
    await until(() => posted)
    list.destroy()
    await clearSync()
    server.user = null
    release()
    await expect(write).rejects.toMatchObject({ code: "SYNC_CLEARED" })
    const again = createSync("todos", { fetch, interval: false, where: { listId: "l2" } })
    stores.push(again)
    await again.refresh()
    expect(again.getState().rows).toEqual([])
  })

  it("forgets every row and queued write on clearSync()", async () => {
    const server = createFakeSyncServer()
    server.write({ id: "a", ownerId: "ada", title: "Milk" })
    const store = open(server.fetch)
    await store.refresh()
    server.offline = true
    const write = store.insert({ title: "Eggs" })
    write.then(undefined, () => undefined)
    await until(() => store.getState().queued === 1)
    await clearSync()
    expect(store.getState()).toMatchObject({ rows: [], queued: 0, failures: [] })
    await expect(write).rejects.toMatchObject({ code: "SYNC_CLEARED" })
    server.offline = false
    server.user = "bob"
    await store.refresh()
    expect(server.applied).toEqual([])
  })
})
