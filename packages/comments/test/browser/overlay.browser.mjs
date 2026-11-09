// Mounts the comments overlay from its sources in headless Chromium, next to a page with text and a site menu, and
// checks what a person does on that page. The real Comments API answers from memory. happy-dom computes no CSS and
// has no layout, so these checks need a real browser.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_BROWSER_PORT ?? 4797)
const harness = fileURLToPath(new URL("../harness.ts", import.meta.url))
const handlerFile = fileURLToPath(new URL("../../src/runtime/handler.ts", import.meta.url))

/** Serves `/api/_vitehub/comments/**` from the real handler, with one signed-in person. */
function commentsApi() {
  let comments
  return {
    name: "comments-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/api/_vitehub/comments/")) return next()
        const [{ createComments }, { createCommentsHandler }, { H3 }] = await Promise.all([server.ssrLoadModule(harness), server.ssrLoadModule(handlerFile), import("h3")])
        comments ??= await createComments()
        const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false, session: () => ({ id: "u1", name: "Maxi" }) }))
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await app.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
    threads: async () => (await comments.list())[1],
  }
}

const highlights = page => page.evaluate(() => Object.fromEntries([...CSS.highlights].map(([name, highlight]) => [name, highlight.size])))

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.mouse.up()
}

test("comments on a page, as in Drop", { timeout: 120_000 }, async (t) => {
  const api = commentsApi()
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // Pre-bundling found on the first load reloads the page in the middle of a test.
    optimizeDeps: { noDiscovery: true },
    plugins: [standaloneUI(), api],
    resolve: { alias: overlayAliases, dedupe: ["vue"] },
    root: fileURLToPath(new URL("./page", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  // Register each cleanup before the next step can fail, so a failed launch does not keep the server open.
  t.after(() => server.close())
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } })
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  // Until the session answers, the pill shows a busy "Comments" button. The comment layer mounts with the listeners.
  await page.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
  const composer = page.locator("vitehub-comments textarea[aria-label='Comment']")

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

  await t.test("selected text gets a Comment bar, and the comment keeps the quote highlighted", async () => {
    const box = await page.locator("#first").boundingBox()
    // Only text inside the <strong>, so the pin has to find the paragraph's gutter.
    const strong = await page.locator("#first strong").boundingBox()
    await drag(page, { x: box.x + 2, y: box.y + 10 }, { x: strong.x + strong.width * 0.8, y: box.y + 10 })
    assert.match(await page.evaluate(() => getSelection().toString()), /^Most of you/)
    const bar = page.locator("vitehub-comments .selection-bar")
    await bar.waitFor({ timeout: 5000 })
    await bar.getByRole("button", { name: /Comment/ }).click()
    await composer.waitFor({ timeout: 5000 })
    assert.equal((await highlights(page))["vitehub-comment-active"], 1)
    await composer.fill("Say which airport")
    await composer.press("Enter")
    await page.waitForFunction(() => CSS.highlights.get("vitehub-comment")?.size === 1, undefined, { timeout: 5000 })
    const [thread] = await api.threads()
    assert.equal(thread.anchor.kind, "text")
    assert.match(thread.anchor.exact, /^Most of you/)
  })

  await t.test("the pin sits in the gutter beside the quote and opens its thread", async () => {
    const pin = page.locator("vitehub-comments [data-slot='comment-pin']").first()
    const [pinBox, text] = [await pin.boundingBox(), await page.locator("#first").boundingBox()]
    assert.ok(pinBox.x >= text.x + text.width, "the pin covers no text")
    await pin.click()
    await page.locator("vitehub-comments").getByText("Say which airport").waitFor({ timeout: 5000 })
    await page.keyboard.press("Escape")
  })

  await t.test("a scroll does not repaint the highlights, and a change to the page does", async () => {
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // Away from the pins, so no hover changes while the page moves.
    await page.mouse.move(5, 5)
    await page.evaluate(() => {
      document.body.style.paddingBottom = "2000px"
      window.highlightPaints = 0
      const set = CSS.highlights.set.bind(CSS.highlights)
      CSS.highlights.set = (...args) => { window.highlightPaints++; return set(...args) }
    })
    try {
      // The padding is a change to the page too. Count from after it.
      await frames()
      await page.evaluate(() => { window.highlightPaints = 0 })
      for (const y of [40, 80, 120, 0]) {
        await page.evaluate(top => scrollTo(0, top), y)
        await frames()
      }
      assert.equal(await page.evaluate(() => window.highlightPaints), 0)
      await page.evaluate(() => document.querySelector("#second").append(" More."))
      await page.waitForFunction(() => window.highlightPaints > 0, undefined, { timeout: 5000 })
    }
    finally {
      await page.evaluate(() => { document.body.style.paddingBottom = ""; scrollTo(0, 0) })
    }
  })

  await t.test("in comment mode a drag comments on an area", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    const box = await page.locator("#second").boundingBox()
    await drag(page, { x: box.x + 10, y: box.y + 4 }, { x: box.x + 200, y: box.y + box.height - 4 })
    await composer.waitFor({ timeout: 5000 })
    await composer.fill("This paragraph is too long")
    await composer.press("Enter")
    await page.waitForFunction(() => document.querySelector("vitehub-comment-areas")?.shadowRoot.querySelector(".area"), undefined, { timeout: 5000 })
    const threads = await api.threads()
    assert.equal(threads.length, 2)
    assert.ok(threads.some(thread => thread.anchor.kind === "area"))
  })

  await t.test("a drag past the end of a short page draws no area that would be cut", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    const box = await page.locator("#second").boundingBox()
    const body = await page.locator("body").boundingBox()
    assert.ok(body.y + body.height < 680, "the test page ends above the drag")
    // Away from the pin of the area above.
    await drag(page, { x: box.x + 300, y: box.y + 4 }, { x: box.x + 500, y: 680 })
    await page.waitForTimeout(300)
    assert.equal(await composer.count(), 0)
    assert.equal((await api.threads()).length, 2)
  })

  await t.test("Enter comments on the focused element, and the focus goes back to it after the comment", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator(".menu-button").focus()
    await page.keyboard.press("Enter")
    await composer.waitFor({ timeout: 5000 })
    await composer.fill("Rename the menu")
    await composer.press("Escape")
    const status = page.locator("vitehub-comments [data-slot='comment-composer-status']")
    assert.equal(await status.textContent(), "Press Esc again to discard.")
    assert.ok((await status.boundingBox()).height > 0, "the hint shows")
    await composer.press("Escape")
    await composer.waitFor({ state: "detached", timeout: 5000 })
    assert.equal(await page.evaluate(() => document.activeElement?.className), "menu-button")
  })

  await t.test("on a narrow screen a new comment stays on screen", async () => {
    await page.setViewportSize({ width: 390, height: 720 })
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    // In the middle and near the right edge, where the card opens on the left of the spot.
    for (const x of [200, 380]) {
      await page.mouse.click(x, 30)
      await composer.waitFor({ timeout: 5000 })
      const card = await page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']").boundingBox()
      assert.ok(card.x >= 0 && card.x + card.width <= 390, `at x ${x} the card is at ${card.x}..${card.x + card.width}`)
      await page.keyboard.press("Escape")
      await composer.waitFor({ state: "detached", timeout: 5000 })
    }
    await page.setViewportSize({ width: 1024, height: 720 })
  })

  await t.test("a tap on the Comment bar comments on the selected text", async () => {
    const touch = await browser.newPage({ viewport: { width: 390, height: 720 }, hasTouch: true })
    try {
      await touch.goto(`http://127.0.0.1:${port}/`)
      await touch.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
      await touch.evaluate(() => {
        const range = document.createRange()
        range.selectNodeContents(document.querySelector("#second"))
        getSelection().removeAllRanges()
        getSelection().addRange(range)
      })
      const button = touch.locator("vitehub-comments .selection-bar button")
      await button.waitFor({ timeout: 5000 })
      // No hover color on a touch screen, where a tap would leave it on.
      await button.hover()
      assert.equal(await button.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)")
      // Under reduced motion a press does not scale the button.
      await touch.emulateMedia({ reducedMotion: "reduce" })
      assert.doesNotMatch(await button.evaluate(element => getComputedStyle(element).transitionProperty), /scale/)
      // A tap on a phone can clear the selection before the click lands, as a press outside the selected text does.
      await touch.evaluate(() => addEventListener("pointerdown", () => getSelection().removeAllRanges(), { capture: true }))
      await button.tap()
      await touch.locator("vitehub-comments textarea[aria-label='Comment']").waitFor({ timeout: 5000 })
      assert.equal((await highlights(touch))["vitehub-comment-active"], 1)
    }
    finally {
      await touch.close()
    }
  })

  assert.deepEqual(errors, [])
})
