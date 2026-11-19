// Runs the comments client in headless Chromium with the real IndexedDB store: a comment with a picture waits in the
// outbox, the page reloads, and the new page sends it with the same bytes. The page loads from a routed origin, so no
// server listens.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { build } from "vite"

const output = await build({
  configFile: false,
  logLevel: "silent",
  build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("../../src/client.ts", import.meta.url)), formats: ["es"], fileName: "entry" } },
})
const client = (Array.isArray(output) ? output[0] : output).output.find(chunk => chunk.type === "chunk" && chunk.isEntry).code
const origin = "http://localhost:4873"

test("a waiting comment keeps its picture in IndexedDB across a reload", { timeout: 120_000 }, async (t) => {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext()
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/client.js") return route.fulfill({ contentType: "text/javascript", body: client })
    return route.fulfill({
      contentType: "text/html",
      body: `<script type="module">
        import { createCommentsClient } from "/client.js"
        // A transport whose create never answers on the first page, as a tab that closes while it sends.
        window.mount = (send) => {
          const transport = {
            list: async () => [], get: async () => null, users: async () => [],
            create: send, reply: send, edit: send, delete: send, resolve: send, reopen: send,
          }
          window.comments = createCommentsClient({ transport, user: { id: "ana" }, outbox: { account: "ana" } })
          window.comments.start()
        }
        window.ready = true
      </script>`,
    })
  })

  const page = await context.newPage()
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => window.ready)
  const saved = await page.evaluate(async () => {
    window.mount(() => new Promise(() => undefined))
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const thread = await window.comments.create({ subject: { kind: "page", id: "/" }, anchor: { kind: "page" }, body: "See the picture", files: [new File([bytes], "shot.png", { type: "image/png" })] })
    return { id: thread.id, persisted: window.comments.outbox.persisted }
  })
  assert.equal(saved.persisted, true)

  await page.reload()
  await page.waitForFunction(() => window.ready)
  const sent = await page.evaluate(async () => {
    const creates = []
    window.mount(async (input) => {
      creates.push(input)
      const message = { id: "m1", threadId: "t1", body: input.body, author: { id: "ana" }, mentions: [], attachments: ["comments/1/shot.png"], createdAt: 1 }
      return { id: "t1", scope: "site", n: 1, subject: input.subject, anchor: input.anchor, status: "open", author: { id: "ana" }, messages: [message], createdAt: 1, updatedAt: 1, requestId: input.requestId }
    })
    const start = Date.now()
    while (window.comments.outbox.entries.length > 0 || creates.length === 0) {
      if (Date.now() - start > 10_000) throw new Error("The saved comment did not go out.")
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const [file] = creates[0].files
    return {
      requestId: creates[0].requestId,
      body: creates[0].body,
      name: file.name,
      type: file.type,
      bytes: [...new Uint8Array(await file.arrayBuffer())],
      threads: window.comments.threads.map(thread => ({ id: thread.id, waiting: Boolean(thread.delivery) })),
    }
  })
  assert.deepEqual(sent, {
    requestId: saved.id,
    body: "See the picture",
    name: "shot.png",
    type: "image/png",
    bytes: [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3],
    threads: [{ id: "t1", waiting: false }],
  })
})
