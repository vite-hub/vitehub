// The disclosure effect of the motion layer in Chromium: the chevron of a `<details>` or of an `aria-expanded` trigger
// turns on a spring when it opens or closes. It runs the page `motion/disclosure.html` and reads each frame.
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

async function open(query = "") {
  const context = await browser.newContext({ viewport: { width: 600, height: 600 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}disclosure.html${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/**
 * Records the chevron of `selector` on every frame until `stop()`: the angle that the page draws it at (its `transform`
 * and its `rotate` together), what the layer wrote, and the CSS transition of the chevron.
 */
async function sample(page, selector) {
  await page.evaluate((selector) => {
    const chevron = document.querySelector(`${selector} .chev`)
    const angle = () => {
      const style = getComputedStyle(chevron)
      const matrix = /^matrix\(([^)]+)\)$/.exec(style.transform)
      const [a = 1, b = 0] = matrix ? matrix[1].split(",").map(Number) : []
      const rotate = style.rotate === "none" ? 0 : Number.parseFloat(style.rotate.split(" ").at(-1))
      return Math.round((Math.atan2(b, a) * 180 / Math.PI + rotate) * 10) / 10
    }
    const frames = []
    let running = true
    const tick = () => {
      const style = getComputedStyle(chevron)
      const durations = style.transitionDuration.split(",")
      // A CSS transition that turns the chevron: on `transform`, `rotate`, or `all`, with a duration.
      const transition = style.transitionProperty.split(",").some((property, index) => /^\s*(?:transform|rotate|all)\s*$/.test(property) && Number.parseFloat(durations[index % durations.length]) > 0)
      frames.push({ angle: angle(), written: chevron.style.rotate, transition })
      if (running) requestAnimationFrame(tick)
    }
    tick()
    window.stopSample = () => {
      running = false
      return frames
    }
  }, selector)
  return { stop: () => page.evaluate(() => window.stopSample()) }
}

/** Clicks the summary or the button of a disclosure and returns its frames until the spring has settled. */
async function toggle(page, selector, trigger = `${selector} > summary`) {
  const trace = await sample(page, selector)
  await page.locator(trigger).click()
  await settle(page, selector)
  return trace.stop()
}

/** Waits at least 700ms, then until the layer has cleared what it wrote on the chevron of `selector`. */
async function settle(page, selector) {
  await page.waitForTimeout(700)
  await page.waitForFunction(selector => !document.querySelector(`${selector} .chev`).style.rotate, selector, { timeout: 15_000 })
}

const between = (frames, from, to) => frames.filter(frame => frame.angle > Math.min(from, to) + 5 && frame.angle < Math.max(from, to) - 5)

describe("disclosure", () => {
  test("a <details> chevron that the stylesheet turns with `transform` turns on a spring both ways, and the layer clears what it wrote", async () => {
    const { context, errors, page } = await open()
    const opening = await toggle(page, "#native")
    assert.equal(opening[0].angle, -90)
    assert.equal(opening.at(-1).angle, 0)
    assert.ok(between(opening, -90, 0).length >= 3, `the chevron passes through the angles between: ${opening.map(frame => frame.angle).join(" ")}`)
    assert.ok(opening.some(frame => frame.written), "the layer writes `rotate`")
    assert.equal(opening.at(-1).written, "", "the layer clears `rotate` when the spring settles")
    assert.equal(opening[0].transition, false, "the chevron has no CSS transition that turns it")
    const closing = await toggle(page, "#native")
    assert.equal(closing.at(-1).angle, -90)
    assert.ok(between(closing, 0, -90).length >= 3, `the chevron turns back: ${closing.map(frame => frame.angle).join(" ")}`)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a chevron that the stylesheet turns with the `rotate` property, as Tailwind's `group-open:rotate-90`, turns the same way", async () => {
    const { context, page } = await open()
    const frames = await toggle(page, "#property")
    assert.equal(frames[0].angle, 0)
    assert.equal(frames.at(-1).angle, 90)
    assert.ok(between(frames, 0, 90).length >= 3, frames.map(frame => frame.angle).join(" "))
    assert.ok(Math.max(...frames.map(frame => frame.angle)) > 90, "the snappy spring passes 90deg a little before it settles")
    await context.close()
  })

  test("the chevron of an `aria-expanded` trigger turns when it opens and closes", async () => {
    const { context, page } = await open()
    const opening = await toggle(page, "#expanded", "#expanded")
    assert.equal(opening.at(-1).angle, 180)
    assert.ok(between(opening, 0, 180).length >= 3, opening.map(frame => frame.angle).join(" "))
    const closing = await toggle(page, "#expanded", "#expanded")
    assert.equal(closing.at(-1).angle, 0)
    assert.ok(between(closing, 180, 0).length >= 3, closing.map(frame => frame.angle).join(" "))
    await context.close()
  })

  test("Enter on a focused summary turns the chevron too", async () => {
    const { context, page } = await open()
    await page.locator("#native > summary").focus()
    const trace = await sample(page, "#native")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector("#native").open, undefined, { timeout: 15_000 })
    await settle(page, "#native")
    const frames = await trace.stop()
    assert.equal(frames.at(-1).angle, 0)
    assert.ok(between(frames, -90, 0).length >= 3, frames.map(frame => frame.angle).join(" "))
    await context.close()
  })

  test("a second click in the middle of the turn reverses from where the chevron is, with no jump", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.setMotionSlowFactor(4))
    const trace = await sample(page, "#native")
    await page.locator("#native > summary").click()
    await page.waitForTimeout(120)
    await page.locator("#native > summary").click()
    await page.waitForTimeout(2000)
    const frames = await trace.stop()
    const steps = frames.slice(1).map((frame, index) => Math.abs(frame.angle - frames[index].angle))
    assert.ok(Math.max(...steps) < 30, `no frame jumps more than 30deg: ${frames.map(frame => frame.angle).join(" ")}`)
    assert.equal(frames.at(-1).angle, -90)
    await context.close()
  })

  test("under reduced motion the chevron is at its new angle at once", async () => {
    const { context, page } = await open()
    // A first open and close with motion, so the layer knows both angles.
    await toggle(page, "#native")
    await toggle(page, "#native")
    await page.evaluate(() => window.forceReducedMotion(true))
    const frames = await toggle(page, "#native")
    assert.equal(frames.at(-1).angle, 0)
    assert.deepEqual(between(frames, -90, 0), [])
    assert.ok(frames.every(frame => !frame.written))
    await context.close()
  })

  test("inside data-motion=\"none\", and on a chevron that keeps a CSS transition of its own, the layer writes nothing", async () => {
    const { context, page } = await open()
    const off = await toggle(page, "#off")
    assert.equal(off.at(-1).angle, 0)
    assert.deepEqual(between(off, -90, 0), [], "no motion inside data-motion=none")
    assert.ok(off.every(frame => !frame.written))
    const own = await toggle(page, "#own")
    assert.equal(own.at(-1).angle, 0)
    assert.ok(own.every(frame => !frame.written), "the layer leaves a chevron with its own transition alone")
    await context.close()
  })
})
