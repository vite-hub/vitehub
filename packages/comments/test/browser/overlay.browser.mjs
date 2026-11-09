// Mounts the comments overlay from its sources in headless Chromium, next to a page with text and a site menu, and
// checks what a person does on that page while the overlay is on. happy-dom computes no CSS, so these checks need a
// real browser.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_BROWSER_PORT ?? 4797)

test("the idle overlay leaves the page usable", { timeout: 120_000 }, async (t) => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // Pre-bundling found on the first load reloads the page in the middle of a test.
    optimizeDeps: { noDiscovery: true },
    plugins: [standaloneUI()],
    resolve: { alias: overlayAliases, dedupe: ["vue"] },
    root: fileURLToPath(new URL("./page", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  const browser = await chromium.launch()
  t.after(async () => {
    await browser.close()
    await server.close()
  })
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } })
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.locator("vitehub-comments").waitFor({ state: "attached" })
  // Until the session answers, the pill shows a busy "Comments" button. The comment layer mounts with the listeners.
  await page.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })

  await t.test("a click on the site's own button reaches it", async () => {
    const target = await page.evaluate(() => {
      const box = document.querySelector(".menu-button").getBoundingClientRect()
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.className
    })
    assert.equal(target, "menu-button")
    await page.locator(".menu-button").click({ timeout: 5000 })
    assert.equal(await page.evaluate(() => document.querySelector("#menu").open), true)
    await page.evaluate(() => document.querySelector("#menu").close())
  })

  await t.test("a drag over text selects it", async () => {
    const box = await page.locator("#first").boundingBox()
    await page.mouse.move(box.x + 2, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + 10, { steps: 8 })
    await page.mouse.up()
    assert.match(await page.evaluate(() => getSelection().toString()), /^Most of you/)
  })

  await t.test("in comment mode a click on the page opens a comment there", async () => {
    await page.mouse.click(900, 600)
    await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    await page.mouse.click(300, 300)
    await page.locator("vitehub-comments textarea[aria-label='Comment']").waitFor({ timeout: 5000 })
  })

  assert.deepEqual(errors, [])
})
