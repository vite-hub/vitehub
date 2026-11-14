// Runs the Sync client in headless Chromium against the fake server: the real IndexedDB storage, a reload that keeps
// the outbox, and two tabs with a real BroadcastChannel. Pages load from routed origins, so no server listens. The
// localhost origin is a secure context with Web Locks. The other one has neither Web Locks nor crypto.randomUUID(), as
// an app on a LAN address over HTTP.
// Run: pnpm --filter @vite-hub/sync test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { build } from "vite"

import { createFakeSyncServer } from "../client-fake-server.ts"

async function bundle(entry) {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: ["es"], fileName: "entry" } },
  })
  const [result] = Array.isArray(output) ? output : [output]
  return result.output.find(chunk => chunk.type === "chunk" && chunk.isEntry).code
}

const client = await bundle("../../src/client.ts")
const storage = await bundle("../../src/client/indexeddb.ts")

for (const [origin, secure] of [["http://localhost:4871", true], ["http://sync.test", false]]) {
  test(`the Sync client keeps its rows and outbox in IndexedDB on ${origin}`, { timeout: 120_000 }, async (t) => {
    const server = createFakeSyncServer()
    // A routed request cannot stream, so this server has no live stream. The bench covers live in the page.
    server.live = false
    const browser = await chromium.launch()
    t.after(() => browser.close())
    const context = await browser.newContext()
    await context.route(`${origin}/**`, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<script type="module">import * as sync from "/client.js"; import * as storage from "/storage.js"; window.sync = sync; window.storage = storage; window.ready = true</script>` })
      if (url.pathname === "/client.js") return route.fulfill({ contentType: "text/javascript", body: client })
      if (url.pathname === "/storage.js") return route.fulfill({ contentType: "text/javascript", body: storage })
      if (server.offline) return route.abort("internetdisconnected")
      try {
        const response = await server.fetch(url.pathname + url.search, { method: request.method(), body: request.postData() ?? undefined })
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() })
      }
      catch {
        return route.abort("connectionreset")
      }
    })
    async function open() {
      const page = await context.newPage()
      await page.goto(`${origin}/`)
      await page.waitForFunction(() => window.ready)
      assert.equal(await page.evaluate(() => Boolean(navigator.locks) && typeof crypto.randomUUID === "function"), secure)
      return page
    }

    await t.test("the storage keeps order, resets, and gives the outbox in order", async () => {
      const page = await open()
      const result = await page.evaluate(async () => {
        const memory = { read: async () => { throw new Error("fallback") } }
        const db = window.storage.createIndexedDBStorage(() => memory)
        const scope = { id: "s", values: {} }
        const meta = cursor => ({ scope, key: "id", cursor, account: "acc", version: "v1", defaults: { done: false } })
        await db.write("/a", { meta: meta(1), reset: true, put: [["k2", { id: "k2" }], ["k1", { id: "k1" }]] })
        await db.write("/a", { meta: meta(2), put: [["k1", { id: "k1", title: "changed" }], ["k3", { id: "k3" }]], delete: ["k2"] })
        await db.write("/b", { meta: meta(9), reset: true, put: [["x", { id: "x" }]] })
        const seqs = await db.write("/a", { add: [{ id: "m1", account: "acc", key: "k1", op: "delete" }, { id: "m2", account: "acc", key: "k3", op: "delete" }] })
        // An action has a `name` of its own, which the storage keeps.
        const [actionSeq] = await db.write("/b", { add: [{ id: "a1", account: "acc", key: "a1", op: "action", name: "complete", args: { id: "x" } }] })
        const action = await db.readQueue("/b")
        await db.write("/a", { update: [{ seq: seqs[0], id: "m1", account: "acc", key: "k1", op: "delete", error: { code: "SYNC_NOT_FOUND", message: "No." } }], remove: [seqs[1]] })
        // An update of a write that is gone does not bring it back.
        await db.write("/a", { update: [{ seq: seqs[1], id: "m2", account: "acc", key: "k3", op: "delete", error: { code: "SYNC_NOT_FOUND", message: "No." } }] })
        const a = await db.read("/a")
        const queue = await db.readQueue("/a")
        await db.write("/a", { meta: meta(3), reset: true, put: [["k9", { id: "k9" }]] })
        const reset = await db.read("/a")
        const b = await db.read("/b")
        await db.clear()
        const cleared = await db.read("/a")
        return { persisted: db.persisted, a, queue, reset: reset.rows, b: b.rows, cleared, seqs, action: action.writes, actionSeq }
      })
      assert.equal(result.persisted, true)
      assert.deepEqual(result.a.meta, { scope: { id: "s", values: {} }, key: "id", cursor: 2, account: "acc", version: "v1", defaults: { done: false } })
      assert.deepEqual(result.a.rows, [["k1", { id: "k1", title: "changed" }], ["k3", { id: "k3" }]])
      assert.deepEqual(result.a.writes, [{ seq: result.seqs[0], id: "m1", account: "acc", key: "k1", op: "delete", error: { code: "SYNC_NOT_FOUND", message: "No." } }])
      assert.equal(result.seqs[1], result.seqs[0] + 1)
      assert.deepEqual(result.queue, { meta: result.a.meta, writes: result.a.writes })
      assert.deepEqual(result.reset, [["k9", { id: "k9" }]])
      assert.deepEqual(result.b, [["x", { id: "x" }]])
      assert.deepEqual(result.action, [{ seq: result.actionSeq, id: "a1", account: "acc", key: "a1", op: "action", name: "complete", args: { id: "x" } }])
      assert.deepEqual(result.cleared, { meta: undefined, rows: [], writes: [] })
      await page.close()
    })

    await t.test("the upgrade from format 1 drops the rows and keeps the outbox", async () => {
      const page = await open()
      const result = await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase("vitehub-sync")
          request.onsuccess = resolve
          request.onerror = reject
        })
        // A format 1 database, as the Sync v1 client wrote it.
        const old = await new Promise((resolve, reject) => {
          const request = indexedDB.open("vitehub-sync", 1)
          request.onupgradeneeded = () => {
            const database = request.result
            database.createObjectStore("rows", { keyPath: ["name", "key"] })
            database.createObjectStore("meta", { keyPath: "name" })
            database.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("name", "name")
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = reject
        })
        const transaction = old.transaction(["rows", "meta", "outbox"], "readwrite")
        transaction.objectStore("rows").put({ name: "/a", key: "k1", order: 0, row: { id: "k1" } })
        transaction.objectStore("meta").put({ name: "/a", format: 1, next: 1, scope: { id: "s", values: {} }, key: "id", cursor: 4 })
        transaction.objectStore("outbox").add({ name: "/a", id: "m1", scope: "s", key: "k1", op: "delete" })
        transaction.objectStore("outbox").add({ name: "/a", id: "m2", scope: null, key: "k2", op: "insert", value: { title: "Early" } })
        await new Promise(resolve => transaction.oncomplete = resolve)
        old.close()
        const db = window.storage.createIndexedDBStorage(() => { throw new Error("no fallback") })
        const stored = await db.read("/a")
        await db.clear()
        return stored
      })
      assert.deepEqual(result.meta, undefined)
      assert.deepEqual(result.rows, [])
      assert.deepEqual(result.writes.map(({ seq: _seq, ...write }) => write), [
        { id: "m1", account: "s", key: "k1", op: "delete" },
        { id: "m2", account: null, key: "k2", op: "insert", value: { title: "Early" } },
      ])
      await page.close()
    })

    await t.test("an offline insert survives a reload and is sent once when online", async () => {
      server.write({ id: "a", ownerId: "ada", title: "Milk" })
      const page = await open()
      await page.evaluate(async () => {
        window.todos = window.sync.createSync("todos", { interval: false })
        await window.todos.refresh()
      })
      server.offline = true
      const key = await page.evaluate(async () => {
        const write = window.todos.insert({ title: "Eggs" })
        write.then(undefined, () => undefined)
        await window.todos.refresh()
        return write.key
      })
      await page.reload()
      await page.waitForFunction(() => window.ready)
      const restored = await page.evaluate(async () => {
        window.todos = window.sync.createSync("todos", { interval: false })
        await window.todos.refresh()
        const { rows, queued, persisted, status } = window.todos.getState()
        return { rows, queued, persisted, status }
      })
      assert.equal(restored.persisted, true)
      assert.equal(restored.status, "offline")
      assert.equal(restored.queued, 1)
      assert.deepEqual(restored.rows.map(row => row.title), ["Milk", "Eggs"])
      assert.equal(server.applied.length, 0)
      server.offline = false
      const sent = await page.evaluate(async () => {
        await window.todos.refresh()
        const { rows, queued, status } = window.todos.getState()
        return { rows, queued, status }
      })
      assert.deepEqual(sent, { rows: [{ id: "a", ownerId: "ada", title: "Milk" }, { id: key, ownerId: "ada", title: "Eggs" }], queued: 0, status: "ready" })
      assert.equal(server.applied.length, 1)
      await page.close()
    })

    await t.test("two tabs see each other's writes, and each write is sent once", async () => {
      const one = await open()
      const two = await open()
      for (const page of [one, two]) await page.evaluate(() => { window.todos = window.sync.createSync("todos", { interval: false }); return window.todos.refresh() })
      const before = server.applied.length
      const key = await one.evaluate(() => window.todos.insert({ title: "Bread" }).key)
      await two.waitForFunction(key => window.todos.getState().rows.some(row => row.id === key), key)
      await one.evaluate(key => window.todos.update(key, { title: "Rye bread" }), key)
      await two.evaluate(() => window.todos.refresh())
      await one.evaluate(() => window.todos.refresh())
      await two.waitForFunction(key => window.todos.getState().queued === 0 && window.todos.get(key)?.title === "Rye bread", key)
      assert.equal(server.applied.length - before, 2)
      // Without Web Locks both tabs may send a write. The server answers the second with `duplicate`.
      if (secure) assert.equal(server.requests.filter(request => request.method === "POST").flatMap(request => request.body.mutations).filter(mutation => mutation.key === key || mutation.value?.id === key).length, 2)
    })

    await t.test("clearSync() forgets the stored copy in every tab", async () => {
      const [one, two] = context.pages()
      server.offline = true
      await one.evaluate(() => { window.todos.insert({ title: "Secret" }).then(undefined, () => undefined) })
      await two.waitForFunction(() => window.todos.getState().queued === 1)
      await one.evaluate(() => window.sync.clearSync())
      await two.waitForFunction(() => window.todos.getState().rows.length === 0 && window.todos.getState().queued === 0)
      const stored = await two.evaluate(async () => {
        const db = window.storage.createIndexedDBStorage(() => { throw new Error("no fallback") })
        return db.read("/api/_vitehub/sync/todos")
      })
      assert.deepEqual(stored, { meta: undefined, rows: [], writes: [] })
      server.offline = false
    })
  })
}
