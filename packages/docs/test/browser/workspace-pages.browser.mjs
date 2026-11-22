import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { test } from "node:test"

import { chromium } from "playwright-core"

const output = process.env.DOCS_OUTPUT
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" }
async function serve(root) {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://local").pathname)).replace(/^(\.\.[/\\])+/, "")
    const candidates = [join(root, path), join(root, path, "index.html"), `${join(root, path)}.html`]
    for (const file of candidates) {
      if (!(await stat(file).catch(() => undefined))?.isFile()) continue
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" })
      return response.end(await readFile(file))
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(4792, "127.0.0.1", resolve))
  return server
}

test("workspace pages of the docs playground", { timeout: 10 * 60_000 }, async (t) => {
  const server = output ? await serve(output) : undefined
  t.after(() => server?.close())
  const base = output ? "http://127.0.0.1:4792" : process.env.DOCS_URL ?? "http://127.0.0.1:4791"
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  await t.test("a query link opens its example, also on a prerendered page", async () => {
    for (const query of ["example=clock", "template=clock"]) {
      const page = await context.newPage()
      await page.goto(`${base}/docs/try/playground?${query}`, { timeout: 180_000 })
      await page.getByRole("button", { name: "Example: Clock" }).waitFor({ timeout: 180_000 })
      assert.equal(await page.locator(".vh-ws-start-grid").count(), 0, query)
      await page.close()
    }
  })

  await t.test("the chooser gives every example its own URL, the first one too", async () => {
    const page = await context.newPage()
    await page.goto(`${base}/docs/try/playground`, { timeout: 180_000 })
    const first = page.locator(".vh-ws-start-grid button").first()
    await first.waitFor({ timeout: 180_000 })
    assert.equal(new URL(page.url()).search, "")
    await first.click()
    await page.waitForURL(/\?example=hello$/, { timeout: 15_000 })
    await page.close()
  })

  await t.test("Reset after Solve restores the start files of the step, and Next does not warn", async () => {
    const page = await context.newPage()
    await page.goto(`${base}/docs/try/first-server`, { timeout: 180_000 })
    await page.getByRole("treeitem").first().waitFor({ timeout: 180_000 })
    const reset = page.getByRole("button", { name: "Reset", exact: true })
    assert.equal(await reset.isDisabled(), true)

    await page.getByRole("button", { name: "Solve" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor()
    assert.equal(await reset.isEnabled(), true)

    await reset.click()
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor({ state: "detached" })
    assert.equal(await reset.isDisabled(), true)

    await page.getByRole("button", { name: "Solve" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor()
    await page.getByRole("button", { name: "Next: Add the time" }).click()
    await page.getByText("Step 2 of 2").first().waitFor()
    assert.equal(await page.getByRole("button", { name: "Load step 2" }).count(), 0)
    await page.close()
  })
})
