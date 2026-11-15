// Mounts the comments overlay from its sources in headless Chromium, next to a page with text and a site menu, and
// checks what a person does on that page. The real Comments API answers from memory. happy-dom computes no CSS and
// has no layout, so these checks need a real browser.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_BROWSER_PORT ?? 4797)
/** A folder for screenshots of the flows, for pull request evidence. */
const evidence = process.env.COMMENTS_BROWSER_EVIDENCE
const harness = fileURLToPath(new URL("../harness.ts", import.meta.url))
const handlerFile = fileURLToPath(new URL("../../src/runtime/handler.ts", import.meta.url))

/** Serves `/api/_vitehub/comments/**` from the real handler, with one signed-in person. */
function commentsApi() {
  let comments
  const files = new Map()
  return {
    name: "comments-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/api/_vitehub/comments/")) return next()
        const [{ createComments }, { createCommentsHandler }, { H3 }] = await Promise.all([server.ssrLoadModule(harness), server.ssrLoadModule(handlerFile), import("h3")])
        comments ??= await createComments({
          storeAttachment: (file) => {
            files.set(`files/${file.name}`, file)
            return `files/${file.name}`
          },
          readAttachment: key => files.has(key) ? new Blob([files.get(key).data], { type: files.get(key).type }) : null,
        })
        const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false, session: () => ({ id: "u1", name: "Maxi" }) }))
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await app.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
    threads: async () => (await comments.list())[1],
    files,
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
    // The bubble takes ViteHub's theme, as Drop does: no focus ring around it, a neutral send button, and Geist first.
    const bubble = await page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']").evaluate((element) => {
      const send = [...element.querySelectorAll("button")].at(-1)
      const [red, green, blue] = getComputedStyle(send).backgroundColor.match(/\d+/g).map(Number)
      return { outline: getComputedStyle(element).outlineStyle, neutral: Math.max(red, green, blue) - Math.min(red, green, blue) < 8, font: getComputedStyle(element).fontFamily }
    })
    assert.deepEqual({ ...bubble, font: bubble.font.split(",")[0] }, { outline: "none", neutral: true, font: "\"Geist Variable\"" })
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

  await t.test("every item of the Comments segment centers on the pill's line, in comment mode too", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator("vitehub-tool").getByRole("button", { name: "Whole page" }).waitFor({ timeout: 5000 })
    try {
      // Avatars and dividers do not fill the row's height, so they show it first when the alignment is lost.
      const centers = await page.evaluate(() => [...document.querySelector("vitehub-tool").shadowRoot.querySelectorAll(".toolbar button, .toolbar .divider, .toolbar .people")]
        .map(item => { const box = item.getBoundingClientRect(); return [item.className || item.textContent, box.top + box.height / 2] }))
      assert.ok(centers.some(([name]) => name === "divider"), "comment mode shows its dividers")
      const line = centers[0][1]
      for (const [name, center] of centers) assert.ok(Math.abs(center - line) <= 0.5, `${name} centers at ${center}, the pill at ${line}`)
    }
    finally {
      await page.keyboard.press("Escape")
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

  await t.test("an area is a soft line, and its thread opens in Drop's small card behind a round face", async () => {
    await page.keyboard.press("Escape")
    await page.mouse.move(5, 5)
    // Once no thread is open or hovered, its area is a 1px line with no fill. The fill fades out in 120ms.
    await page.waitForFunction(() => {
      const area = document.querySelector("vitehub-comment-areas").shadowRoot.querySelector(".area")
      const style = getComputedStyle(area)
      return area.dataset.status === "open" && style.borderTopWidth === "1px" && style.backgroundColor === "rgba(0, 0, 0, 0)"
    }, undefined, { timeout: 5000 })
    // The line is the comment blue, as in Drop, not grey or black.
    const [red, green, blue] = await page.evaluate(() => {
      const color = getComputedStyle(document.querySelector("vitehub-comment-areas").shadowRoot.querySelector(".area")).borderTopColor
      const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    })
    assert.ok(blue > red + 60 && blue > green, `the area line is rgb(${red}, ${green}, ${blue})`)
    const pin = page.locator("vitehub-comments [data-slot='comment-layer-item'][data-kind='area'] [data-slot='comment-pin']")
    const corners = await pin.evaluate(element => [element, element.querySelector("[data-slot='avatar-stack-item']")].map(node => getComputedStyle(node).borderRadius))
    assert.deepEqual(corners, ["14px", "14px"])
    await pin.click()
    const thread = page.locator("vitehub-comments [data-slot='comment-layer-popover'] [data-slot='comment-thread']")
    await thread.waitFor({ timeout: 5000 })
    assert.equal(await thread.getAttribute("data-size"), "sm")
    await page.keyboard.press("Escape")
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

  await t.test("a new area comment that grows past the top of the screen moves under its area", async () => {
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    const box = await page.locator("#second").boundingBox()
    await drag(page, { x: box.x + 300, y: box.y + 4 }, { x: box.x + 500, y: box.y + box.height - 4 })
    await composer.waitFor({ timeout: 5000 })
    const card = page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']")
    assert.equal(await page.locator("vitehub-comments [data-slot='comment-layer-item'][data-draft='true']").getAttribute("data-above"), "true")
    await composer.fill(Array.from({ length: 9 }, (_, line) => `Line ${line + 1}`).join("\n"))
    await page.waitForTimeout(200)
    assert.ok((await card.boundingBox()).y >= 0, `the card starts at ${(await card.boundingBox()).y}`)
    await composer.press("Escape")
    await composer.press("Escape")
    await composer.waitFor({ state: "detached", timeout: 5000 })
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
    if (!await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    for (const rootSize of [16, 10]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px` }, rootSize)
      for (const width of [375, 390]) {
        await page.setViewportSize({ width, height: 720 })
        // Include a spot with too little room on either side, plus the middle and right edge.
        for (const x of [100, 180, 200, width - 10]) {
          await page.mouse.click(x, 30)
          await composer.waitFor({ timeout: 5000 })
          const bubble = page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']")
          await bubble.evaluate(card => Promise.all(card.getAnimations().map(animation => animation.finished)))
          await composer.fill("A visible Send button")
          const card = await bubble.boundingBox()
          assert.ok(card.x >= 0 && card.x + card.width <= width, `at x ${x} in ${width}px (${rootSize}px root) the card is at ${card.x}..${card.x + card.width}`)
          const send = bubble.locator("button[aria-label='Comment']")
          assert.equal(await send.isEnabled(), true)
          const button = await send.boundingBox()
          assert.ok(button.x >= 0 && button.x + button.width <= width, `Send is at ${button.x}..${button.x + button.width}`)
          const anchor = await bubble.evaluate(card => Number.parseFloat(card.parentElement.style.left))
          assert.ok(Math.abs(anchor - x) < 1, `the pin stays on its anchor at ${x} (got ${anchor})`)
          await composer.fill("")
          await page.keyboard.press("Escape")
          await composer.waitFor({ state: "detached", timeout: 5000 })
        }
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "" })
    await page.setViewportSize({ width: 1024, height: 720 })
  })

  await t.test("two quotes of one paragraph get two pins that each take a click", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    if (await page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))) await page.keyboard.press("c")
    await page.evaluate(() => {
      const text = document.querySelector("#first").lastChild
      const range = document.createRange()
      range.setStart(text, text.data.indexOf("worth"))
      range.setEnd(text, text.data.indexOf("worth") + "worth staying".length)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    })
    await page.locator("vitehub-comments .selection-bar").waitFor({ timeout: 5000 })
    await page.keyboard.press("c")
    await composer.fill("Second quote")
    await composer.press("Enter")
    await composer.waitFor({ state: "detached", timeout: 5000 })
    const pins = page.locator("vitehub-comments [data-slot='comment-pin'][aria-label*='quote'], vitehub-comments [data-slot='comment-pin'][aria-label*='airport']")
    await page.waitForFunction(() => document.querySelector("vitehub-comments").shadowRoot.querySelectorAll("[data-slot='comment-pin'][aria-label*='Second quote']").length === 1)
    const boxes = await pins.evaluateAll(elements => elements.map((pin) => {
      const box = pin.getBoundingClientRect()
      const hit = pin.getRootNode().elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return { label: pin.getAttribute("aria-label"), y: box.y, hit: hit?.closest("[data-slot='comment-pin']") === pin }
    }))
    assert.equal(boxes.length, 2)
    assert.ok(Math.abs(boxes[0].y - boxes[1].y) >= 28, JSON.stringify(boxes))
    assert.ok(boxes.every(box => box.hit), JSON.stringify(boxes))
    // At the bottom of the screen the stack grows upward, so no pin goes off screen.
    const height = Math.ceil(Math.max(...boxes.map(box => box.y))) + 20
    await page.setViewportSize({ width: 1024, height })
    await page.waitForTimeout(200)
    const low = await pins.evaluateAll(elements => elements.map(pin => pin.getBoundingClientRect().bottom))
    await page.setViewportSize({ width: 1024, height: 720 })
    assert.ok(low.every(bottom => bottom <= height), `pins end at ${low} in a ${height}px screen`)
  })

  await t.test("highlights the page and comments with a picture of the strokes", async () => {
    await page.evaluate(() => getSelection().removeAllRanges())
    await page.mouse.click(900, 600)
    await page.keyboard.press("b")
    const layer = page.locator("vitehub-marker .layer")
    await layer.waitFor({ timeout: 5000 })
    // The page under the layer takes no click while highlighting.
    assert.equal(await page.evaluate(() => document.elementFromPoint(300, 200)?.localName), "vitehub-marker")
    const line = await page.evaluate(() => {
      const box = document.querySelector("#second").getBoundingClientRect()
      return { left: box.left + 4, right: box.left + 300, y: box.top + 14 }
    })
    // A stroke can start on an earlier comment's area or pin.
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.localName, { x: line.left, y: line.y }), "vitehub-marker")
    await drag(page, { x: line.left, y: line.y }, { x: line.right, y: line.y })
    if (evidence) await page.screenshot({ path: `${evidence}/highlight-drawing.png` })
    await page.locator("vitehub-tool button", { hasText: "Done" }).click()
    await composer.waitFor({ timeout: 10000 })
    await page.locator("vitehub-comments [data-slot='comment-layer-popover'] [data-slot='attachment']").waitFor({ timeout: 5000 })
    // The strokes stay where they were drawn while the comment is written, and the page takes clicks again.
    assert.equal(await layer.evaluate(element => element.hasAttribute("data-frozen")), true)
    await composer.fill("This flight is wrong")
    if (evidence) await page.screenshot({ path: `${evidence}/highlight-comment.png` })
    await composer.press("Enter")
    await composer.waitFor({ state: "detached", timeout: 10000 })
    await page.locator("vitehub-marker").waitFor({ state: "detached", timeout: 5000 })
    const thread = (await api.threads()).find(item => item.messages[0].body === "This flight is wrong")
    assert.equal(thread.anchor.kind, "area")
    const [key] = thread.messages[0].attachments
    const file = api.files.get(key)
    assert.equal(file.type, "image/webp")
    if (evidence) await writeFile(`${evidence}/highlight-picture.webp`, file.data)
    // The picture is the screen, with the pink ink on the highlighted line and the page's white elsewhere.
    const picture = await page.evaluate(async ({ bytes, at }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/webp" }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext("2d")
      context.drawImage(bitmap, 0, 0)
      const row = (y, from, to) => context.getImageData(from, y, to - from, 1).data
      // Pink ink multiplied over the white page, between the letters: much more red than green.
      const pink = (data) => {
        let count = 0
        for (let index = 0; index < data.length; index += 4) if (data[index] > 220 && data[index] - data[index + 1] > 30 && data[index + 2] > 180) count++
        return count
      }
      return { width: bitmap.width, height: bitmap.height, ink: pink(row(at.y, at.left, at.right)), blank: pink(row(at.y + 120, at.left, at.right)) }
    }, { bytes: [...file.data], at: { left: Math.round(line.left), right: Math.round(line.right), y: Math.round(line.y) } })
    assert.deepEqual([picture.width, picture.height], [1024, 720])
    assert.ok(picture.ink > 60, `${picture.ink} pink pixels on the highlighted line`)
    assert.equal(picture.blank, 0)
  })

  await t.test("draws with the pen, an arrow, and a label, in four colors, and the picture carries each", async () => {
    const tips = await browser.newPage({ viewport: { width: 1024, height: 720 } })
    try {
      await tips.goto(`http://127.0.0.1:${port}/`)
      await tips.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
      await tips.mouse.click(900, 600)
      await tips.keyboard.press("b")
      const layer = tips.locator("vitehub-marker .layer")
      await layer.waitFor({ timeout: 5000 })
      const pick = label => tips.locator(`vitehub-tool button[aria-label='${label}']`).click()
      const line = await tips.evaluate(() => {
        const box = document.querySelector("#second").getBoundingClientRect()
        return { left: box.left + 4, right: box.left + 300, y: box.top + 14 }
      })
      // The marker, pink, over a line of text.
      await drag(tips, { x: line.left, y: line.y }, { x: line.right, y: line.y })
      // The pen, blue, under the text. P picks it.
      await tips.keyboard.press("p")
      await pick("Blue ink")
      await drag(tips, { x: 220, y: 470 }, { x: 420, y: 470 })
      // An arrow, green.
      await pick("Arrow")
      await pick("Green ink")
      await drag(tips, { x: 460, y: 600 }, { x: 620, y: 480 })
      // A label, amber: a click places it, Enter puts it down.
      await tips.keyboard.press("t")
      await pick("Amber ink")
      await tips.mouse.click(660, 560)
      await tips.keyboard.type("Too big")
      assert.equal(await tips.locator("vitehub-marker input[aria-label='Label']").inputValue(), "Too big")
      if (evidence) await tips.screenshot({ path: `${evidence}/tips-typing.png` })
      await tips.keyboard.press("Enter")
      await tips.locator("vitehub-marker .label").waitFor({ timeout: 5000 })
      assert.equal(await tips.locator("vitehub-marker path.marker").count(), 1)
      assert.equal(await tips.locator("vitehub-marker path.pen").count(), 1)
      assert.equal(await tips.locator("vitehub-marker path.arrow").count(), 1)
      assert.equal(await tips.locator("vitehub-tool button[aria-label='Text']").getAttribute("aria-pressed"), "true")
      if (evidence) await tips.screenshot({ path: `${evidence}/tips-drawing.png` })

      await tips.locator("vitehub-tool button", { hasText: "Done" }).click()
      const box = tips.locator("vitehub-comments textarea[aria-label='Comment']")
      await box.waitFor({ timeout: 10000 })
      const file = tips.locator("vitehub-comments [data-slot='comment-layer-popover'] [data-slot='attachment'] img")
      await file.waitFor({ timeout: 10000 })
      await box.fill("Each tip, in its color")
      if (evidence) await tips.screenshot({ path: `${evidence}/tips-comment.png` })
      // The picture: each tip's ink where it was drawn, in its color.
      const counts = await file.evaluate(async (image, at) => {
        const blob = await (await fetch(image.src)).blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext("2d")
        context.drawImage(bitmap, 0, 0)
        const count = (left, top, width, height, test) => {
          const data = context.getImageData(left, top, width, height).data
          let found = 0
          for (let index = 0; index < data.length; index += 4) if (test(data[index], data[index + 1], data[index + 2])) found++
          return found
        }
        return {
          size: [bitmap.width, bitmap.height],
          picture: [...new Uint8Array(await blob.arrayBuffer())],
          pink: count(at.left, at.y - 2, at.right - at.left, 4, (r, g, b) => r > 220 && r - g > 30 && b > 180),
          blue: count(230, 466, 180, 8, (r, g, b) => b > 180 && r < 80 && g < 140),
          green: count(500, 500, 100, 90, (r, g, b) => g > 120 && r < 60 && b < 110),
          amber: count(655, 548, 20, 24, (r, g, b) => r > 220 && g > 130 && g < 180 && b < 60),
          dark: count(660, 548, 70, 24, (r, g, b) => r < 40 && g < 40 && b < 40),
          // Nothing drawn in the blank band between the text and the pen.
          blank: count(220, 420, 400, 20, (r, g, b) => !(r > 240 && g > 240 && b > 240)),
        }
      }, { left: Math.round(line.left), right: Math.round(line.right), y: Math.round(line.y) })
      if (evidence) await writeFile(`${evidence}/tips-picture.webp`, Buffer.from(counts.picture))
      assert.deepEqual(counts.size, [1024, 720])
      assert.ok(counts.pink > 60, `${counts.pink} pink pixels on the marked line`)
      assert.ok(counts.blue > 150, `${counts.blue} blue pixels on the pen's line`)
      assert.ok(counts.green > 100, `${counts.green} green pixels on the arrow`)
      assert.ok(counts.amber > 100, `${counts.amber} amber pixels in the label`)
      // Amber is light, so the label's words are near-black.
      assert.ok(counts.dark > 20, `${counts.dark} dark pixels of the label's words`)
      assert.equal(counts.blank, 0)
    }
    finally {
      await tips.close()
    }
  })

  await t.test("the picture keeps sticky and fixed parts of a scrolled page where they are on screen", async () => {
    const scrolled = await browser.newPage({ viewport: { width: 1024, height: 720 } })
    try {
      await scrolled.goto(`http://127.0.0.1:${port}/`)
      await scrolled.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
      await scrolled.evaluate(() => {
        const header = document.createElement("header")
        header.style.cssText = "position:sticky;top:0;height:48px;background:rgb(18,52,86)"
        document.body.prepend(header)
        const tall = document.createElement("div")
        tall.style.height = "2000px"
        document.body.append(tall)
        scrollTo(0, 600)
      })
      await scrolled.mouse.click(900, 400)
      await scrolled.keyboard.press("b")
      await scrolled.locator("vitehub-marker .layer").waitFor({ timeout: 5000 })
      await drag(scrolled, { x: 300, y: 300 }, { x: 600, y: 300 })
      await scrolled.locator("vitehub-tool button", { hasText: "Done" }).click()
      const file = scrolled.locator("vitehub-comments [data-slot='comment-layer-popover'] [data-slot='attachment'] img")
      await file.waitFor({ timeout: 10000 })
      // The picture in the box: the header stays at the top, and the site's fixed Menu button at the bottom left.
      const colors = await file.evaluate(async (image) => {
        const bitmap = await createImageBitmap(await (await fetch(image.src)).blob())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext("2d")
        context.drawImage(bitmap, 0, 0)
        const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]
        return { header: pixel(500, 20), menu: pixel(30, 680), size: [bitmap.width, bitmap.height] }
      })
      if (evidence) await scrolled.screenshot({ path: `${evidence}/highlight-scrolled.png` })
      assert.deepEqual(colors.size, [1024, 720])
      assert.ok(colors.header.every((channel, index) => Math.abs(channel - [18, 52, 86][index]) < 12), `header ${colors.header}`)
      assert.ok(colors.menu.every(channel => channel > 200 && channel < 250), `menu button ${colors.menu}`)
    }
    finally {
      await scrolled.close()
    }
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

  await t.test("on a touch screen the Comment bar goes above text that ends near the bottom edge, clear of the system menu", async () => {
    const touch = await browser.newPage({ viewport: { width: 390, height: 720 }, hasTouch: true })
    try {
      await touch.goto(`http://127.0.0.1:${port}/`)
      await touch.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
      const end = await touch.evaluate(() => {
        // Moves the paragraph down until its text ends at 700px, 20px above the bottom edge.
        const second = document.querySelector("#second")
        const range = document.createRange()
        range.selectNodeContents(second)
        second.style.marginTop = `${parseFloat(getComputedStyle(second).marginTop) + 700 - range.getBoundingClientRect().bottom}px`
        getSelection().removeAllRanges()
        getSelection().addRange(range)
        return range.getBoundingClientRect().bottom
      })
      assert.ok(Math.abs(end - 700) < 2, `selection ends at ${end}`)
      const button = touch.locator("vitehub-comments .selection-bar button")
      await button.waitFor({ timeout: 5000 })
      const box = await touch.locator("vitehub-comments .selection-bar").boundingBox()
      assert.ok(box.y >= 0 && box.y + box.height <= 720, `bar from ${box.y} to ${box.y + box.height}`)
      const start = await touch.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().top)
      // The system's text menu opens just above the selection, so the bar leaves it 64px.
      assert.ok(start - (box.y + box.height) >= 63, `bar ends at ${box.y + box.height}, text starts at ${start}`)
      // The stand-in pill has the type of the real one, so screenshots show the toolbar as people see it.
      const cdp = await touch.context().newCDPSession(touch)
      await cdp.send("DOM.getDocument", { depth: -1, pierce: true })
      await cdp.send("CSS.enable")
      const { result } = await cdp.send("Runtime.evaluate", { expression: `(() => {
        const tool = document.querySelector("vitehub-tool")
        for (const root of [tool.shadowRoot, tool].filter(Boolean)) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim() === "Comments") return node.parentElement
        }
      })()` })
      const { nodeId } = await cdp.send("DOM.requestNode", { objectId: result.objectId })
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId })
      assert.ok(fonts.length > 0 && fonts.every(font => !/serif/i.test(font.familyName) || /sans/i.test(font.familyName)), `toolbar fonts ${fonts.map(font => font.familyName)}`)
      if (evidence) await touch.screenshot({ path: `${evidence}/touch-bar-near-bottom.png` })
      await button.tap()
      await touch.locator("vitehub-comments textarea[aria-label='Comment']").waitFor({ timeout: 5000 })
    }
    finally {
      await touch.close()
    }
  })

  assert.deepEqual(errors, [])
})
