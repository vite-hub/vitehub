// Runs live Sync stores in headless Chromium against the fake server behind a real HTTP/1.1 server, so the browser
// keeps its limit of six connections for one origin. A routed request cannot stream, so this test has its own server.
// Run: pnpm --filter @vite-hub/sync test:browser
import assert from "node:assert/strict"
import { createServer } from "node:http"
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

/** Resolves once `check` passes. */
async function until(check, timeout = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("The condition did not become true in time.")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const client = await bundle("../../src/client.ts")

/** An HTTP server for the page, the client bundle, and the fake Sync server, with streamed answers. */
async function serve(sync) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/") return response.writeHead(200, { "content-type": "text/html" }).end(`<script type="module">import * as sync from "/client.js"; window.sync = sync; window.ready = true</script>`)
    if (url.pathname === "/client.js") return response.writeHead(200, { "content-type": "text/javascript" }).end(client)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const controller = new AbortController()
    response.on("close", () => controller.abort())
    let answer
    try {
      answer = await sync.fetch(url.pathname + url.search, { method: request.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined, signal: controller.signal })
    }
    catch {
      return response.destroy()
    }
    response.writeHead(answer.status, Object.fromEntries(answer.headers))
    if (!answer.body) return response.end()
    try {
      for await (const chunk of answer.body) response.write(chunk)
    }
    catch {
      // The browser closed the stream.
    }
    response.end()
  })
  await new Promise(resolve => server.listen(0, resolve))
  return { origin: `http://localhost:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve).closeAllConnections()) }
}

async function hide(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
}

test("live Sync stores share one connection for each tab", { timeout: 120_000 }, async (t) => {
  const sync = createFakeSyncServer()
  const http = await serve(sync)
  const browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await http.close()
  })
  const context = await browser.newContext()
  async function open() {
    const page = await context.newPage()
    await page.goto(`${http.origin}/`)
    await page.waitForFunction(() => window.ready)
    return page
  }

  await t.test("six live stores in one tab use one stream, and a write goes out at once", async () => {
    const page = await open()
    await page.evaluate(async () => {
      window.lists = Array.from({ length: 6 }, (_, index) => window.sync.createSync("todos", { where: { listId: `l${index}` }, interval: false }))
      await Promise.all(window.lists.map(list => list.refresh()))
    })
    await page.waitForFunction(() => window.lists.every(list => list.getState().live))
    await new Promise(resolve => setTimeout(resolve, 300))
    // With a stream for each store, the six streams take the six connections of the origin, and the push waits for
    // the server to end one of them.
    const elapsed = await page.evaluate(async () => {
      const start = performance.now()
      const stalled = new Promise(resolve => setTimeout(() => resolve("stalled"), 5000))
      const sent = await Promise.race([window.lists[0].insert({ title: "Milk" }).then(() => "sent"), stalled])
      return sent === "sent" ? performance.now() - start : sent
    })
    assert.equal(typeof elapsed, "number", `The push did not go out in 5 seconds, with ${sync.streams} open streams`)
    assert.ok(elapsed < 2000, `The push took ${elapsed} ms`)
    assert.equal(sync.streams, 1)
    sync.write({ id: "x", ownerId: "ada", listId: "l4", title: "From the server" })
    await page.waitForFunction(() => window.lists[4].get("x")?.title === "From the server")
    assert.equal(await page.evaluate(() => window.lists[3].get("x")), undefined)
    assert.equal(sync.streams, 1)
    await page.close()
    await until(() => sync.streams === 0)
  })

  await t.test("two tabs stream once each, and a store open in both streams in one of them", async () => {
    const one = await open()
    const two = await open()
    await one.evaluate(() => {
      window.todos = window.sync.createSync("todos", { interval: false })
      window.list = window.sync.createSync("todos", { where: { listId: "one" }, interval: false })
      return Promise.all([window.todos.refresh(), window.list.refresh()])
    })
    await one.waitForFunction(() => window.todos.getState().live && window.list.getState().live)
    await two.evaluate(() => {
      window.todos = window.sync.createSync("todos", { interval: false })
      window.list = window.sync.createSync("todos", { where: { listId: "two" }, interval: false })
      return Promise.all([window.todos.refresh(), window.list.refresh()])
    })
    await two.waitForFunction(() => window.list.getState().live)
    await until(() => sync.streams === 2)
    // The first tab leads the store that both tabs have. The second tab gets its changes from it.
    assert.equal(await two.evaluate(() => window.todos.getState().live), false)
    sync.write({ id: "a", ownerId: "ada", title: "Both tabs" })
    sync.write({ id: "b", ownerId: "ada", listId: "two", title: "Second tab" })
    await one.waitForFunction(() => window.todos.get("a") !== undefined)
    await two.waitForFunction(() => window.todos.get("a") !== undefined && window.list.get("b") !== undefined)

    // The first tab hides. The second tab takes over the shared store, in its own stream.
    await hide(one)
    await two.waitForFunction(() => window.todos.getState().live)
    await until(() => sync.streams === 1)
    sync.write({ id: "c", ownerId: "ada", title: "After the switch" })
    await two.waitForFunction(() => window.todos.get("c") !== undefined)
    await one.close()
    await two.close()
  })
})
