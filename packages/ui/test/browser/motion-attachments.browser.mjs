// The pictures of a comment in Chromium: the stack of a comment box, and the mosaic of a message with its preview. It
// runs the page `motion/attachments.html`, which renders `CommentComposer` and `CommentReply`, and reads what each frame
// draws.
//
// Run: node --test test/browser/motion-attachments.browser.mjs (or pnpm --filter @vite-hub/ui test:motion)
//
// Record mode: MOTION_SHOTS=<dir> also saves screenshots of the stack, the fan, the mosaic, and the preview.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { vitehubTheme } from "../../src/theme.ts"

const root = fileURLToPath(new URL("./motion/", import.meta.url))
const repo = fileURLToPath(new URL("../../../../", import.meta.url))
const nuxtUIRequire = createRequire(fileURLToPath(import.meta.resolve("@nuxt/ui/vite")))
const shots = process.env.MOTION_SHOTS
if (shots) mkdirSync(shots, { recursive: true })

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [vue(), nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme })],
  resolve: { alias: [{ find: /^@iconify\/vue$/, replacement: nuxtUIRequire.resolve("@iconify/vue") }] },
  root,
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
})
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open() {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}attachments.html`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/** Picks `count` pictures with the file button of the comment box, as a person does. */
async function pick(page, from, count) {
  await page.evaluate(async ({ from, count }) => {
    const input = document.querySelector("[data-test=composer] input[type=file]")
    const transfer = new DataTransfer()
    for (let index = from; index < from + count; index++) transfer.items.add(await window.picture(index))
    input.files = transfer.files
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, { from, count })
}

/** The boxes of the stack's cards on each frame, for `frames` frames after `start` runs in the page. */
async function traceCards(page, start, frames = 70) {
  return page.evaluate(async ({ start, frames }) => {
    await new Function(`return (${start})()`)()
    const read = () => [...document.querySelectorAll("[data-slot=comment-image-stack-card]")].map((card) => {
      const box = card.getBoundingClientRect()
      return { x: box.left, y: box.top, width: box.width, translate: card.style.translate, scale: card.style.scale }
    })
    const values = []
    for (let index = 0; index < frames; index++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      values.push(read())
    }
    return values
  }, { start: start.toString(), frames })
}

describe("the stack of a comment box", () => {
  test("a picked picture comes out of the attach button into the stack, and the count rolls", async () => {
    const { context, errors, page } = await open()
    await pick(page, 0, 1)
    await page.waitForSelector("[data-slot=comment-image-stack-card]")
    const attach = await page.locator("[data-test=composer] button[aria-label='Add attachment']").boundingBox()
    const frames = await traceCards(page, async () => {
      const input = document.querySelector("[data-test=composer] input[type=file]")
      const transfer = new DataTransfer()
      transfer.items.add(await window.picture(1))
      transfer.items.add(await window.picture(2))
      input.files = transfer.files
      input.dispatchEvent(new Event("change", { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve))
    })
    const first = frames[0]
    assert.equal(first.length, 3)
    // The newest card starts near the attach button, to the right of its place in the stack.
    const rest = frames.at(-1)[2]
    assert.ok(first[2].x > rest.x + 8, `the new card starts at ${first[2].x}, its place is ${rest.x}`)
    assert.ok(Math.abs(first[2].x - attach.x) < Math.abs(rest.x - attach.x))
    // It lands, and the motion layer removes what it wrote.
    assert.deepEqual(frames.at(-1).map(card => card.translate), ["", "", ""])
    assert.equal(await page.locator("[data-slot=comment-image-stack-count]").innerText(), "3")
    assert.deepEqual(await page.evaluate(() => window.files()), ["Screenshot 1.png", "Screenshot 2.png", "Screenshot 3.png"])
    if (shots) await page.locator("[data-test=composer]").screenshot({ path: join(shots, "stack.png") })
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("hover fans the cards out above the box, each travelling from the stack, and leaving folds them back", async () => {
    const { context, errors, page } = await open()
    await pick(page, 0, 3)
    await page.waitForTimeout(800)
    const stack = page.locator("[data-slot=comment-image-stack]")
    const folded = await page.evaluate(() => [...document.querySelectorAll("[data-slot=comment-image-stack-card]")].map(card => card.getBoundingClientRect().width))
    assert.deepEqual(folded.map(Math.round), [28, 28, 28])
    await stack.hover()
    await page.waitForTimeout(900)
    assert.equal(await stack.getAttribute("data-fanned"), "true")
    const fanned = await page.evaluate(() => [...document.querySelectorAll("[data-slot=comment-image-stack-card]")].map(card => card.getBoundingClientRect().toJSON()))
    const box = await page.locator("[data-test=composer] [data-slot=comment-composer]").boundingBox()
    assert.deepEqual(fanned.map(card => Math.round(card.width)), [56, 56, 56])
    assert.ok(fanned.every(card => card.bottom <= box.y), "the fan sits above the box")
    assert.ok(fanned[1].left > fanned[0].left && fanned[2].left > fanned[1].left, "the cards sit side by side")
    if (shots) await page.screenshot({ path: join(shots, "fan.png"), clip: { x: box.x - 20, y: box.y - 110, width: box.width + 40, height: box.height + 130 } })
    // The fan travels: on the frame after the pointer leaves, a card is drawn between its two places.
    const frames = await traceCards(page, async () => {
      const stack = document.querySelector("[data-slot=comment-image-stack]")
      stack.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }))
      await new Promise(resolve => setTimeout(resolve, 260))
    }, 50)
    assert.ok(frames.some(cards => cards[0].scale && cards[0].scale !== "1 1"), "a card is scaled on its way")
    assert.equal(await stack.getAttribute("data-fanned"), null)
    assert.deepEqual(frames.at(-1).map(card => Math.round(card.width)), [28, 28, 28])
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("Remove in the fan takes the picture out of the files, and Esc folds the fan and keeps the text", async () => {
    const { context, errors, page } = await open()
    await pick(page, 0, 2)
    await page.locator("[data-test=composer] textarea").fill("See these")
    await page.locator("[data-slot=comment-image-stack-toggle]").click()
    await page.waitForTimeout(500)
    await page.locator("button[aria-label='Remove Screenshot 1.png']").click()
    assert.deepEqual(await page.evaluate(() => window.files()), ["Screenshot 2.png"])
    // The removed card folds away as a copy of itself; the one left is the card without the copy's mark.
    await page.locator("[data-slot=comment-image-stack-card]:not([data-motion-ghost]) .vh-image-preview").focus()
    await page.keyboard.press("Escape")
    assert.equal(await page.locator("[data-slot=comment-image-stack]").getAttribute("data-fanned"), null)
    assert.equal(await page.locator("[data-test=composer] textarea").inputValue(), "See these")
    assert.deepEqual(errors, [])
    await context.close()
  })
})

describe("the mosaic of a message", () => {
  test("six pictures show four tiles, the last with +3", async () => {
    const { context, errors, page } = await open()
    const images = page.locator("[data-test=thread] [data-slot=comment-reply-images]")
    assert.equal(await images.getAttribute("data-count"), "4")
    assert.equal(await images.locator("[data-slot=comment-reply-image]").count(), 4)
    assert.equal(await images.locator("[data-slot=comment-reply-image-more]").innerText(), "+3")
    await page.waitForFunction(() => [...document.querySelectorAll("[data-slot=comment-reply-image] img")].every(image => image.complete))
    if (shots) await page.locator("[data-test=thread]").screenshot({ path: join(shots, "mosaic.png") })
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a tile opens its picture from where it is, the arrows step, and Esc sends it back to its tile", async () => {
    const { context, errors, page } = await open()
    await page.waitForFunction(() => [...document.querySelectorAll("[data-slot=comment-reply-image] img")].every(image => image.complete))
    const tile = await page.locator("[data-slot=comment-reply-image]").first().boundingBox()
    const opening = await page.evaluate(async () => {
      document.querySelector("[data-slot=comment-reply-image]").click()
      const boxes = []
      for (let index = 0; index < 60; index++) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const image = document.querySelector(".vh-image-gallery .vh-image-dialog__image")
        if (image) boxes.push({ ...image.getBoundingClientRect().toJSON(), scale: image.style.scale })
      }
      return boxes
    })
    const start = opening.find(box => box.scale)
    assert.ok(start, "the picture travels")
    // It starts on its tile, and lands larger with nothing written.
    assert.ok(Math.abs(start.x + start.width / 2 - (tile.x + tile.width / 2)) < 40, `it starts at ${start.x}, the tile is at ${tile.x}`)
    assert.ok(start.width < opening.at(-1).width / 2)
    assert.equal(opening.at(-1).scale, "")
    assert.equal(await page.locator("[data-slot=comment-reply-image]").first().getAttribute("data-open"), "true")
    if (shots) await page.screenshot({ path: join(shots, "preview.png") })
    await page.keyboard.press("ArrowRight")
    assert.equal(await page.locator(".vh-image-gallery .vh-image-dialog__name").innerText(), "Screenshot 2.png")
    await page.waitForTimeout(400)
    assert.match(await page.locator(".vh-image-gallery__count").innerText(), /2\s*of 6/)
    await page.keyboard.press("Escape")
    // The picture flies back to the second tile, and the dialog closes when it lands.
    await page.waitForTimeout(80)
    assert.equal(await page.locator(".vh-image-gallery").count(), 1)
    await page.waitForSelector(".vh-image-gallery", { state: "detached", timeout: 3000 })
    assert.equal(await page.locator("[data-slot=comment-reply-image][data-open]").count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("under reduced motion the picture opens and closes at once", async () => {
    const { context, errors, page } = await open()
    await page.evaluate(() => window.reduce(true))
    await page.locator("[data-slot=comment-reply-image]").first().click()
    await page.waitForSelector(".vh-image-gallery .vh-image-dialog__image")
    assert.equal(await page.locator(".vh-image-gallery .vh-image-dialog__image").evaluate(image => image.style.scale), "")
    await page.keyboard.press("Escape")
    await page.waitForSelector(".vh-image-gallery", { state: "detached", timeout: 500 })
    assert.deepEqual(errors, [])
    await context.close()
  })
})
