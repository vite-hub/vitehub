// Mounts the comments overlay from its sources in headless Chromium, next to a page with text and a site menu, and
// checks what a person does on that page. The real Comments API answers from memory. happy-dom computes no CSS and
// has no layout, so these checks need a real browser.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_BROWSER_PORT ?? 4797)
/** A folder for screenshots of the flows, for pull request evidence. */
const evidence = process.env.COMMENTS_BROWSER_EVIDENCE
const builtOverlay = new URL("../../dist/overlay/", import.meta.url)
const harness = fileURLToPath(new URL("../harness.ts", import.meta.url))
const handlerFile = fileURLToPath(new URL("../../src/runtime/handler.ts", import.meta.url))

/** Serves `/_vitehub/comments/**` from the real handler, with one signed-in person. */
function commentsApi() {
  let comments
  const files = new Map()
  return {
    name: "comments-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/_vitehub/comments/")) return next()
        const [{ createComments }, { createCommentsHandler }, { H3 }] = await Promise.all([server.ssrLoadModule(harness), server.ssrLoadModule(handlerFile), import("h3")])
        comments ??= await createComments({
          storeAttachment: (file) => {
            files.set(`files/${file.name}`, file)
            return `files/${file.name}`
          },
          readAttachment: key => files.has(key) ? new Blob([files.get(key).data], { type: files.get(key).type }) : null,
        })
        const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false, session: async () => ({ id: "u1", name: "Maxi" }) }))
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await app.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
    threads: async () => (await comments.list())[1],
    /** The threads once `ready` holds for them: a new comment shows at once and goes out after. */
    async stored(ready) {
      for (let tries = 0; tries < 100; tries++) {
        const threads = (await comments.list())[1]
        if (ready(threads)) return threads
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return (await comments.list())[1]
    },
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
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 }, ...(evidence ? { recordVideo: { dir: evidence, size: { width: 1024, height: 720 } } } : {}) })
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  // Until the session answers, the pill shows a busy "Comments" button. The comment layer mounts with the listeners.
  await page.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
  const composer = page.locator("vitehub-comments textarea[aria-label='Comment']")

  await t.test("document highlights follow CSS-only themes with a light system preference", async (t) => {
    t.after(() => page.evaluate(() => document.documentElement.removeAttribute("style")))
    await page.emulateMedia({ colorScheme: "light" })
    await page.evaluate(() => document.documentElement.style.cssText = "color-scheme: dark; background: #171717; color: white")
    const colors = () => page.evaluate(() => {
      const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")
      return ["vh-comment", "vh-comment-resolved", "vh-comment-active", "vh-comment-draft"].map(name => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = getComputedStyle(document.querySelector("#first"), `::highlight(${name})`).backgroundColor
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      })
    })
    await page.waitForFunction(() => document.querySelector("vitehub-comments").dataset.theme === "dark")
    for (const [red, , , alpha] of await colors()) assert.ok(red > 200 && alpha > 0, "dark-page highlights use light ink")
    await page.evaluate(() => document.documentElement.style.colorScheme = "light")
    await page.waitForFunction(() => document.querySelector("vitehub-comments").dataset.theme === "light")
    for (const [red, , , alpha] of await colors()) assert.ok(red < 100 && alpha > 0, "light-page highlights use dark ink")
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), false)
  })

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
    const bar = page.locator("vitehub-comments [data-slot='comment-selection-bar']")
    await bar.waitFor({ timeout: 5000 })
    await bar.getByRole("button", { name: /Comment/ }).click()
    await composer.waitFor({ timeout: 5000 })
    assert.equal((await highlights(page))["vh-comment-draft"], 1)
    await composer.fill("Say which airport")
    // The bubble takes ViteHub's theme, as Drop does: no focus ring around it, a neutral send button, and Geist first.
    const bubble = await page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']").evaluate((element) => {
      const send = [...element.querySelectorAll("button")].at(-1)
      const [red, green, blue] = getComputedStyle(send).backgroundColor.match(/\d+/g).map(Number)
      return { outline: getComputedStyle(element).outlineStyle, neutral: Math.max(red, green, blue) - Math.min(red, green, blue) < 8, font: getComputedStyle(element).fontFamily }
    })
    assert.deepEqual({ ...bubble, font: bubble.font.split(",")[0] }, { outline: "none", neutral: true, font: "\"Geist Variable\"" })
    await composer.press("Enter")
    await page.waitForFunction(() => CSS.highlights.get("vh-comment")?.size === 1, undefined, { timeout: 5000 })
    const [thread] = await api.stored(threads => threads.length === 1)
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
    await page.waitForFunction(() => document.querySelector("vitehub-comment-areas")?.shadowRoot.querySelector("[data-slot='comment-mark-area']"), undefined, { timeout: 5000 })
    const threads = await api.stored(threads => threads.length === 2)
    assert.equal(threads.length, 2)
    assert.ok(threads.some(thread => thread.anchor.kind === "area"))
  })

  await t.test("an area is a soft grey line, and its thread opens in Drop's small card behind a round face", async () => {
    await page.keyboard.press("Escape")
    await page.mouse.move(5, 5)
    // Once no thread is open or hovered, its area is a 1px line with no fill.
    await page.waitForFunction(() => {
      const area = document.querySelector("vitehub-comment-areas").shadowRoot.querySelector("[data-slot='comment-mark-area']")
      const style = getComputedStyle(area)
      return area.dataset.status === "open" && style.borderTopWidth === "1px" && style.backgroundColor === "rgba(0, 0, 0, 0)"
    }, undefined, { timeout: 5000 })
    // The line is a soft neutral tint of the ink, not the comment blue, so a page with many areas stays calm.
    const [red, green, blue, alpha] = await page.evaluate(() => {
      const color = getComputedStyle(document.querySelector("vitehub-comment-areas").shadowRoot.querySelector("[data-slot='comment-mark-area']")).borderTopColor
      const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data]
    })
    assert.ok(Math.max(red, green, blue) - Math.min(red, green, blue) <= 4 && alpha > 20 && alpha < 90, `the area line is rgba(${red}, ${green}, ${blue}, ${alpha})`)
    const pin = page.locator("vitehub-comments [data-slot='comment-layer-item'][data-kind='area'] [data-slot='comment-pin']")
    const corners = await pin.evaluate(element => [element, element.querySelector("[data-slot='avatar-stack-item']")].map(node => getComputedStyle(node).borderRadius))
    assert.deepEqual(corners, ["14px", "14px"])
    await pin.click()
    const thread = page.locator("vitehub-comments [data-slot='comment-layer-popover'] [data-slot='comment-thread']")
    await thread.waitFor({ timeout: 5000 })
    assert.equal(await thread.getAttribute("data-size"), "sm")
    // Drop's card: 340px, and the one small corner is the one nearest the pin. offsetWidth ignores the pop-in scale.
    const card = await thread.evaluate((element) => {
      const style = getComputedStyle(element.parentElement)
      return { corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].sort(), width: element.parentElement.offsetWidth }
    })
    assert.deepEqual(card, { corners: ["16px", "16px", "16px", "6px"], width: 340 })
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
        for (const [x, y] of [[100, 30], [180, 150], [200, 30], [width - 10, 30], [180, 600]]) {
          await page.mouse.click(x, y)
          await composer.waitFor({ timeout: 5000 })
          const bubble = page.locator("vitehub-comments [data-draft='true'] > [data-slot='comment-layer-popover']")
          // The bubble comes out of its pin with the appear effect of the motion layer. Wait until it rests.
          await bubble.evaluate(card => new Promise((resolve) => {
            const check = () => (card.style.translate || card.style.clipPath || card.style.opacity ? requestAnimationFrame(check) : resolve())
            check()
          }))
          await composer.fill("A visible Send button")
          const card = await bubble.boundingBox()
          assert.ok(card.x >= 0 && card.x + card.width <= width, `at x ${x} in ${width}px (${rootSize}px root) the card is at ${card.x}..${card.x + card.width}`)
          const send = bubble.locator("button[aria-label='Comment']")
          assert.equal(await send.isEnabled(), true)
          const button = await send.boundingBox()
          assert.ok(button.x >= 0 && button.x + button.width <= width, `Send is at ${button.x}..${button.x + button.width}`)
          const pin = await page.locator("vitehub-comments [data-slot='comment-pin'][data-draft='true']").boundingBox()
          assert.ok(Math.abs(pin.x - x) < 1 && Math.abs(pin.y + pin.height - y) < 1, `the pin stays on its anchor at (${x}, ${y})`)
          assert.ok(Math.max(card.x - pin.x - pin.width, pin.x - card.x - card.width, card.y - pin.y - pin.height, pin.y - card.y - card.height) >= 7.5,
            `the card clears the pin at (${x}, ${y}) in ${width}px (${rootSize}px root)`)
          await composer.fill("")
          await page.keyboard.press("Escape")
          await composer.waitFor({ state: "detached", timeout: 5000 })
        }
      }
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "" })
    await page.setViewportSize({ width: 1024, height: 720 })
  })

  await t.test("the whole-page draft is centered", async () => {
    await page.locator("vitehub-tool").getByRole("button", { name: "Whole page" }).click()
    const bubble = page.locator("vitehub-comments [data-draft='true'][data-kind='page'] > [data-slot='comment-layer-popover']")
    await bubble.evaluate(card => new Promise((resolve) => {
      const check = () => (card.style.translate || card.style.clipPath || card.style.opacity ? requestAnimationFrame(check) : resolve())
      requestAnimationFrame(check)
    }))
    const card = await bubble.boundingBox()
    assert.ok(Math.abs(card.x + card.width / 2 - 512) < 1, `the card centers at ${card.x + card.width / 2}`)
    const pin = await page.locator("vitehub-comments [data-slot='comment-pin'][data-draft='true']").boundingBox()
    assert.ok(card.y - pin.y - pin.height >= 7.5, "the card clears the pin")
    await composer.press("Escape")
    await composer.waitFor({ state: "detached", timeout: 5000 })
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
    await page.locator("vitehub-comments [data-slot='comment-selection-bar']").waitFor({ timeout: 5000 })
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
    const thread = (await api.stored(threads => threads.some(item => item.messages[0].body === "This flight is wrong"))).find(item => item.messages[0].body === "This flight is wrong")
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
      const button = touch.locator("vitehub-comments [data-slot='comment-selection-bar-action']")
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
      assert.equal((await highlights(touch))["vh-comment-draft"], 1)
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
      const button = touch.locator("vitehub-comments [data-slot='comment-selection-bar-action']")
      await button.waitFor({ timeout: 5000 })
      // The bar rises from the text with the appear effect of the motion layer. Measure it where it rests.
      await touch.locator("vitehub-comments [data-slot='comment-selection-bar']").evaluate(bar => new Promise((resolve) => {
        const check = () => (bar.style.translate || bar.style.clipPath || bar.style.opacity ? requestAnimationFrame(check) : resolve())
        check()
      }))
      const box = await touch.locator("vitehub-comments [data-slot='comment-selection-bar']").boundingBox()
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

  await t.test("the Comment bar keeps its size and stays on screen when the page's root text is larger", async () => {
    const large = await browser.newPage({ viewport: { width: 1024, height: 720 } })
    try {
      await large.goto(`http://127.0.0.1:${port}/`)
      await large.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached" })
      // Text near the top left corner, so the bar has to go under it and stay inside the left edge.
      await large.evaluate(() => {
        document.documentElement.style.fontSize = "24px"
        const first = document.querySelector("#first")
        Object.assign(first.style, { position: "fixed", left: "0", top: "20px", margin: "0" })
        const range = document.createRange()
        range.selectNodeContents(first.querySelector("strong"))
        getSelection().removeAllRanges()
        getSelection().addRange(range)
      })
      const bar = large.locator("vitehub-comments [data-slot='comment-selection-bar']")
      await bar.waitFor({ timeout: 5000 })
      await large.waitForTimeout(200)
      const box = await bar.boundingBox()
      assert.equal(Math.round(box.height), 38)
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 720, `bar at ${JSON.stringify(box)}`)
    }
    finally {
      await large.close()
    }
  })

  await t.test("with comments hidden, a new comment shows for a moment, then pops out, and the others stay hidden", async () => {
    await page.mouse.click(900, 650)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.mouse.move(5, 5)
    const items = page.locator("vitehub-comments [data-slot='comment-layer-item']:not([data-draft])")
    const areas = () => page.evaluate(() => document.querySelector("vitehub-comment-areas").shadowRoot.querySelectorAll("[data-slot='comment-mark-area']").length)
    const all = await items.count()
    assert.ok(all >= 3, `${all} pins before the eye`)
    if (evidence) await page.screenshot({ path: `${evidence}/hidden-0-all.png` })
    const eye = page.locator("vitehub-tool").getByRole("button", { name: "Hide comments" })
    await eye.click()
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    await page.waitForFunction(() => document.querySelectorAll("vitehub-comments").length && !document.querySelector("vitehub-comments").shadowRoot.querySelector("[data-slot='comment-layer-item']"), undefined, { timeout: 5000 })
    assert.equal(await areas(), 0)
    assert.equal((await highlights(page))["vh-comment"] ?? 0, 0)
    assert.equal(await page.evaluate(() => localStorage.getItem("vitehub-comments-visibility")), "hidden")
    if (evidence) await page.screenshot({ path: `${evidence}/hidden-1-eye.png` })

    await page.keyboard.press("c")
    await page.locator("vitehub-comments [data-slot='comment-layer-overlay']").waitFor()
    const box = await page.locator("#second").boundingBox()
    await page.mouse.click(box.x + box.width - 40, box.y + 8)
    await composer.waitFor({ timeout: 5000 })
    // Writing a comment does not bring the others back.
    assert.equal(await items.count(), 0)
    await composer.fill("Only this one shows")
    await composer.press("Enter")
    await page.mouse.move(5, 5)
    // The item is a zero-size anchor, so wait for its pin. From then on the page records each change of the pins, as
    // the pop-out lasts 180ms and a screenshot can take longer.
    await items.first().locator("[data-slot='comment-pin']").waitFor({ timeout: 5000 })
    await page.evaluate(() => {
      const root = document.querySelector("vitehub-comments").shadowRoot
      const start = performance.now()
      const log = window.pinLog = []
      const record = () => {
        // The leave effect of the motion layer folds an inert copy of a leaving pin away. The copy is not a pin.
        const pins = [...root.querySelectorAll("[data-slot='comment-layer-item']:not([data-draft], [data-motion=none])")].filter(item => item.querySelector("[data-slot='comment-pin']"))
        const copy = root.querySelector("[data-slot='comment-layer-item'][data-motion=none]")
        const entry = { at: performance.now() - start, count: pins.length, leaving: pins.some(item => item.dataset.leaving === "true"), hidden: pins.some(item => item.style.opacity === "0"), copy: Boolean(copy) }
        const last = log.at(-1)
        if (!last || last.count !== entry.count || last.leaving !== entry.leaving || last.copy !== entry.copy) log.push(entry)
      }
      record()
      new MutationObserver(record).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-leaving", "style"] })
    })
    assert.equal(await items.count(), 1)
    assert.match(await items.first().locator("[data-slot='comment-pin']").getAttribute("aria-label"), /Only this one shows/)
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    if (evidence) await page.screenshot({ path: `${evidence}/hidden-2-flash.png` })

    await page.waitForFunction(() => window.pinLog.at(-1).count === 0, undefined, { timeout: 5000 })
    const log = await page.evaluate(() => window.pinLog)
    const leave = log.find(entry => entry.leaving)
    assert.ok(leave, `the pin popped out: ${JSON.stringify(log)}`)
    // Shown since the send, then it leaves.
    assert.ok(leave.at >= 1800 && leave.at < 3000, `the new comment showed for ${leave.at}ms`)
    assert.ok(leave.hidden && leave.copy, `the pin hid and a copy of it folded away: ${JSON.stringify(leave)}`)
    // The page keeps the hidden pin for commentLeaveMs, while its copy folds away.
    const gone = log.find(entry => entry.at > leave.at && entry.count === 0).at - leave.at
    assert.ok(gone >= 120 && gone < 500, `the pin went after ${gone}ms`)
    assert.ok(log.every(entry => entry.count <= 1), "no other pin showed")
    await page.waitForFunction(() => !document.querySelector("vitehub-comments").shadowRoot.querySelector("[data-slot='comment-layer-item']:not([data-draft])"), undefined, { timeout: 3000 })
    assert.equal(await areas(), 0)
    assert.equal(await eye.getAttribute("aria-pressed"), "true")
    if (evidence) await page.screenshot({ path: `${evidence}/hidden-4-after.png` })

    await page.keyboard.press("Escape")
    await eye.click()
    await page.waitForFunction(count => document.querySelector("vitehub-comments").shadowRoot.querySelectorAll("[data-slot='comment-layer-item']").length === count, all + 1, { timeout: 5000 })
    assert.equal(await page.evaluate(() => localStorage.getItem("vitehub-comments-visibility")), null)
  })

  assert.deepEqual(errors, [])
})

test("the built overlay loads its chunks from its own folder", { timeout: 60_000 }, async (t) => {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext()
  // A routed origin: the page is at the root and the built overlay at the asset path of the Comments routes.
  const origin = "http://localhost:4799"
  const assets = "/_vitehub/comments/assets/"
  const scripts = []
  await context.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith(".js")) scripts.push(path)
    if (path === "/") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><main><p>Hello</p></main><script type="module">
        import start from "${assets}overlay.js"
        const pill = document.createElement("vitehub-pill")
        const bar = document.createElement("vitehub-tool")
        bar.slot = "comments"
        pill.append(bar)
        document.documentElement.append(pill)
        start({
          tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "${assets}overlay.js" },
          bar,
          signal: new AbortController().signal,
          open: false,
          exit() {},
          onOpen() {},
          beforeExit() {},
          openTool: async () => false,
          createWindow() { throw new Error("Unexpected retained window") },
        })
      </script>` })
    }
    if (path.startsWith(assets)) {
      const body = await readFile(new URL(path.slice(assets.length), builtOverlay)).catch(() => undefined)
      return body ? route.fulfill({ contentType: "text/javascript", body }) : route.fulfill({ status: 404 })
    }
    // Presence is on, so the overlay imports the Realtime client chunk after the session answers.
    if (path === "/_vitehub/comments/session") {
      return route.fulfill({ json: { data: { user: { id: "u1", name: "Maxi" }, can: { read: true, comment: true, resolve: true }, realtime: true, content: false }, people: [] } })
    }
    if (path.startsWith("/_vitehub/comments/")) return route.fulfill({ json: { data: [], people: [] } })
    return route.fulfill({ status: 404 })
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  // The Realtime client opens the room's socket once its chunk has loaded, after the preload links went out.
  const socket = page.waitForEvent("websocket", { timeout: 15_000 })
  await page.goto(`${origin}/`)
  assert.match((await socket).url(), /\/_vitehub\/realtime\/comments\//)
  assert.ok(scripts.length > 1, `the overlay loaded its chunks: ${scripts.join(", ")}`)
  assert.deepEqual(scripts.filter(path => !path.startsWith(assets)), [])
  assert.deepEqual(errors, [])
})
