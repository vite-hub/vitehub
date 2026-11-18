// The disclosure and panel effects of the motion layer in Chromium: a chevron that turns when its `<details>` or its
// `aria-expanded` control opens, and a panel whose width follows a spring when it opens beside the page. It also checks
// the copy of the select effect on the Open and Resolved filters of CommentPanel. It runs the page
// `motion/disclosure.html` and reads each frame of the effect.
//
// Run: node --test test/browser/motion-disclosure.browser.mjs
import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("./motion/", import.meta.url))
const server = await createServer({ configFile: false, logLevel: "warn", root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}disclosure.html`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/** Calls `read(element)` on every frame until `stop()`, and returns what it gave. */
async function sample(page, selector, read) {
  await page.locator(selector).first().evaluate((element, source) => {
    const fn = new Function(`return (${source})`)()
    const values = []
    let running = true
    const tick = () => {
      values.push(fn(element))
      if (running) requestAnimationFrame(tick)
    }
    tick()
    window.stopSample = () => {
      running = false
      return values
    }
  }, read.toString())
  return { stop: () => page.evaluate(() => window.stopSample()) }
}

/** The angle that a person sees: the `rotate` property and the angle of `transform`, and what the layer wrote. */
const angle = (element) => {
  const style = getComputedStyle(element)
  const matrix = /^matrix\(([^)]+)\)$/.exec(style.transform)?.[1]?.split(",").map(Number)
  const transform = matrix ? Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI : 0
  const rotate = style.rotate === "none" ? 0 : Number.parseFloat(style.rotate)
  return { visual: transform + rotate, written: element.style.rotate }
}

const width = element => ({ width: element.getBoundingClientRect().width, page: element.nextElementSibling.getBoundingClientRect().width, written: element.style.width })

describe("disclosure", () => {
  for (const { name, trigger, chevron, end } of [
    { name: "a <details> chevron that `rotate` turns", trigger: "[data-test=summary]", chevron: "[data-test=details-chevron]", end: 90 },
    { name: "an aria-expanded chevron that `transform` turns", trigger: "[data-test=expand]", chevron: "[data-test=expand-chevron]", end: 180 },
  ]) {
    test(`${name} turns with a spring, past its angle once, and the layer clears what it wrote`, async () => {
      const { context, errors, page } = await open()
      await page.evaluate(() => window.setSlow(4))
      const run = await sample(page, chevron, angle)
      await page.click(trigger)
      await page.waitForTimeout(3000)
      const frames = await run.stop()
      const moving = frames.filter(frame => frame.written)
      assert.ok(moving.length > 10, `the chevron turned over ${moving.length} frames`)
      const between = moving.filter(frame => frame.visual > 5 && frame.visual < end - 5)
      assert.ok(between.length > 3, "the chevron passed angles between its two states")
      assert.ok(Math.max(...moving.map(frame => frame.visual)) > end + 0.5, "the spring passed the end angle once")
      const last = frames.at(-1)
      assert.equal(last.written, "")
      assert.ok(Math.abs(last.visual - end) < 0.01, `the chevron rests at ${end}°, not ${last.visual}°`)
      // Each frame is close to the one before: the chevron never jumps.
      for (let index = 1; index < frames.length; index++) assert.ok(Math.abs(frames[index].visual - frames[index - 1].visual) < end / 3)

      // It closes the same way, back to 0.
      const back = await sample(page, chevron, angle)
      await page.click(trigger)
      await page.waitForTimeout(3000)
      const closing = await back.stop()
      assert.ok(closing.some(frame => frame.written && frame.visual > 5 && frame.visual < end - 5))
      assert.equal(closing.at(-1).written, "")
      assert.ok(Math.abs(closing.at(-1).visual) < 0.01)
      assert.deepEqual(errors, [])
      await context.close()
    })
  }

  test("a fast second click turns back from where the chevron is, with no jump", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.setSlow(4))
    const run = await sample(page, "[data-test=details-chevron]", angle)
    await page.click("[data-test=summary]")
    await page.waitForTimeout(250)
    await page.click("[data-test=summary]")
    await page.waitForTimeout(3500)
    const frames = await run.stop()
    const peak = Math.max(...frames.map(frame => frame.visual))
    assert.ok(peak > 5 && peak < 85, `the chevron turned back before it reached 90°, at ${peak}°`)
    for (let index = 1; index < frames.length; index++) assert.ok(Math.abs(frames[index].visual - frames[index - 1].visual) < 20, `frame ${index} jumped`)
    assert.ok(Math.abs(frames.at(-1).visual) < 0.01)
    await context.close()
  })

  test("reduced motion, data-motion=none, and a change from code turn the chevron at once", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.setReduced(true))
    let run = await sample(page, "[data-test=details-chevron]", angle)
    await page.click("[data-test=summary]")
    await page.waitForTimeout(300)
    let frames = await run.stop()
    assert.ok(frames.every(frame => !frame.written), "reduced motion writes nothing")
    assert.equal(frames.at(-1).visual, 90)
    await page.evaluate(() => window.setReduced(undefined))

    run = await sample(page, "[data-test=off-chevron]", angle)
    await page.click("[data-test=off-summary]")
    await page.waitForTimeout(300)
    frames = await run.stop()
    assert.ok(frames.every(frame => !frame.written), "data-motion=none writes nothing")
    assert.equal(frames.at(-1).visual, 90)

    run = await sample(page, "[data-test=expand-chevron]", angle)
    await page.evaluate(() => document.querySelector("#expand").setAttribute("aria-expanded", "true"))
    await page.waitForTimeout(300)
    frames = await run.stop()
    assert.ok(frames.every(frame => !frame.written), "a change that no press started writes nothing")
    assert.ok(Math.abs(frames.at(-1).visual - 180) < 0.01)
    await context.close()
  })

  test("Enter on the focused summary turns the chevron too", async () => {
    const { context, page } = await open()
    const run = await sample(page, "[data-test=details-chevron]", angle)
    await page.focus("[data-test=summary]")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(500)
    const frames = await run.stop()
    assert.ok(frames.some(frame => frame.written && frame.visual > 5 && frame.visual < 85))
    await context.close()
  })
})

describe("panel", () => {
  test("a panel that opens follows a spring to its new width, and the page beside it makes room", async () => {
    const { context, errors, page } = await open()
    await page.evaluate(() => window.setSlow(4))
    const run = await sample(page, "[data-test=panel]", width)
    await page.click("[data-test=toggle-panel]")
    await page.waitForTimeout(3000)
    const frames = await run.stop()
    const moving = frames.filter(frame => frame.written)
    assert.ok(moving.length > 10)
    assert.ok(moving.some(frame => frame.width > 70 && frame.width < 210), "the width passed values between 52px and 232px")
    assert.ok(Math.max(...moving.map(frame => frame.width)) > 232.5, "the spring passed the open width once")
    // The page is the rest of the shell, frame by frame.
    for (const frame of moving) assert.ok(Math.abs(frame.width + frame.page - 518) < 1.5, `${frame.width} + ${frame.page}`)
    assert.equal(frames.at(-1).written, "")
    assert.equal(frames.at(-1).width, 232)
    assert.equal(await page.locator("[data-test=panel]").getAttribute("data-open"), "")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a fast second toggle turns back from the width the panel has", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.setSlow(4))
    const run = await sample(page, "[data-test=panel]", width)
    await page.click("[data-test=toggle-panel]")
    await page.waitForTimeout(250)
    await page.click("[data-test=toggle-panel]")
    await page.waitForTimeout(3500)
    const frames = await run.stop()
    const peak = Math.max(...frames.map(frame => frame.width))
    assert.ok(peak > 60 && peak < 225, `the panel turned back at ${peak}px`)
    for (let index = 1; index < frames.length; index++) assert.ok(Math.abs(frames[index].width - frames[index - 1].width) < 40, `frame ${index} jumped`)
    assert.equal(frames.at(-1).width, 52)
    assert.equal(await page.locator("[data-test=panel]").getAttribute("data-open"), null)
    await context.close()
  })

  test("under reduced motion the panel takes its new width at once", async () => {
    const { context, page } = await open({ reducedMotion: "reduce" })
    const run = await sample(page, "[data-test=panel]", width)
    await page.click("[data-test=toggle-panel]")
    await page.waitForTimeout(300)
    const frames = await run.stop()
    assert.ok(frames.every(frame => !frame.written))
    assert.equal(frames.at(-1).width, 232)
    await context.close()
  })
})

describe("select with a copy of the look", () => {
  test("the copy of the soft background lands on the new radio in a page whose body has a margin", async () => {
    const { context, errors, page } = await open()
    await page.evaluate(() => window.setSlow(4))
    await page.click("[data-test=resolved]")
    // The effect pairs the old and the new radio on the next frame.
    await page.waitForSelector("[data-motion-copy]", { state: "attached" })
    const item = await page.locator("[data-test=resolved]").boundingBox()
    const frames = []
    for (let index = 0; index < 40; index++) {
      const copy = await page.evaluate(() => {
        const element = document.querySelector("[data-motion-copy]")
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height, translate: element.style.translate }
      })
      if (!copy) break
      frames.push(copy)
      await page.waitForTimeout(100)
    }
    assert.ok(frames.length > 3, "a copy of the background travelled")
    // The copy moves along the row only, and it starts at the old radio.
    for (const frame of frames) assert.ok(Math.abs(frame.y + frame.height / 2 - (item.y + item.height / 2)) < 1, `the copy is at y ${frame.y}, the radio at ${item.y}`)
    assert.ok(frames[0].x < item.x - 40)
    await page.waitForFunction(() => !document.querySelector("[data-motion-copy]"), undefined, { timeout: 10_000 })
    assert.equal(await page.locator("[data-test=resolved]").getAttribute("data-motion-select-hidden"), null)
    assert.equal(await page.locator("[data-test=resolved]").evaluate(element => getComputedStyle(element).backgroundColor), "oklch(0.92 0 0)")
    assert.deepEqual(errors, [])
    await context.close()
  })
})
