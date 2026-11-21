// The label, icon, count, and ring helpers of `@vite-hub/ui/motion` in Chromium, on the motion page `motion/`. It reads
// the width, the letters, the digits, and the ring of each change frame by frame.
//
// Run: pnpm --filter @vite-hub/ui test:motion
//
// Record mode: MOTION_RECORD=<dir> also records each change at ¼×. MOTION_PROTOTYPE=<file> adds the same change from the
// prototype HTML file, and MOTION_TODAY=<dir> the motion page of a checkout before this change, to compare. It needs
// ffmpeg.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { vitehubTheme } from "../../src/theme.ts"

const nuxtUIRequire = createRequire(fileURLToPath(import.meta.resolve("@nuxt/ui/vite")))

// The page of another checkout loads Nuxt UI and its Vue plugin from that checkout, so both see the same packages.
async function serve(root, from) {
  // The ESM entry of `name` (and `subpath`) as installed for `from`.
  const entry = (name, subpath, dir) => {
    const root = realpathSync(join(dir, "node_modules", name))
    const exports = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports
    const target = exports[subpath]
    return join(root, typeof target === "string" ? target : target.import?.default ?? target.import ?? target.default)
  }
  const load = async (name, subpath) => {
    if (!from) return name === "@nuxt/ui" ? nuxtUI : vue
    return (await import(pathToFileURL(entry(name, subpath, from)).href)).default
  }
  const ui = await load("@nuxt/ui", "./vite")
  const iconify = from ? createRequire(entry("@nuxt/ui", "./vite", from)).resolve("@iconify/vue") : nuxtUIRequire.resolve("@iconify/vue")
  const server = await createServer({
    // The other checkout may share its node_modules, so its optimized dependencies go to a folder of their own.
    ...from ? { cacheDir: join(root, ".vite-today") } : {},
    configFile: false,
    logLevel: "warn",
    plugins: [(await load("@vitejs/plugin-vue", "."))(), ui({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme })],
    resolve: { alias: [{ find: /^@iconify\/vue$/, replacement: iconify }], dedupe: ["vue"] },
    root,
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  return server
}

const server = await serve(fileURLToPath(new URL("./motion/", import.meta.url)))
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, permissions: ["clipboard-read", "clipboard-write"], ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(base)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

// The first visit can reload the page while Vite optimizes dependencies, so warm it up before the tests.
{
  const page = await browser.newPage()
  await page.goto(base)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 180_000 })
  await page.close()
}

/** Runs `read` on `selector` on every frame until `stop()`, and returns the values with their time in ms. */
async function sample(page, selector, read) {
  await page.evaluate(({ selector, read }) => {
    const element = document.querySelector(selector)
    const reader = new Function("element", `return (${read})(element)`)
    const values = []
    const start = performance.now()
    let running = true
    const frame = () => {
      values.push([performance.now() - start, reader(element)])
      if (running) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    window.stopSample = () => {
      running = false
      return values
    }
  }, { selector, read: read.toString() })
  return { stop: () => page.evaluate(() => window.stopSample()) }
}

/** Waits until the element holds plain text again, the end of a morph or a roll. */
function settled(page, selector) {
  return page.waitForFunction(selector => {
    const element = document.querySelector(selector)
    return element.childNodes.length === 1 && element.firstChild.nodeType === Node.TEXT_NODE
  }, selector, { timeout: 10_000 })
}

function maxStep(values) {
  let step = 0
  for (let index = 1; index < values.length; index++) step = Math.max(step, Math.abs(values[index] - values[index - 1]))
  return step
}

describe("label morph", () => {
  test("a UButton label types in letter by letter, its width follows with no jump and ends at its natural width", async () => {
    const { context, errors, page } = await open()
    const label = "[data-test=publish] > [data-slot=label]"
    const trace = await sample(page, label, element => [Number.parseFloat(getComputedStyle(element).width), element.textContent])
    await page.locator("[data-test=publish]").click()
    await page.waitForFunction(selector => document.querySelector(selector).querySelector("[data-motion-glyphs]"), label)
    // The accessible name and the text are the new label at once.
    assert.equal(await page.getByRole("button", { name: "Publishing" }).count(), 1)
    await settled(page, label)
    await page.waitForTimeout(50)
    const values = await trace.stop()
    const widths = values.map(([, [value]]) => value)
    const changed = values.findIndex(([, [, text]]) => text !== "Publish")
    assert.ok(values.slice(changed).every(([, [, text]]) => text === "Publishing"), "the text reads Publishing from the first frame of the change")
    assert.ok(Math.max(...widths) - Math.min(...widths) > 10, `the width grows, from ${Math.min(...widths)} to ${Math.max(...widths)}`)
    // A jump would move the whole difference in one frame.
    assert.ok(maxStep(widths) < 6, `the width moves at most ${maxStep(widths)}px in one frame: ${widths.map(w => w.toFixed(1)).join(" ")}`)
    const natural = await page.locator(label).evaluate(element => Number.parseFloat(getComputedStyle(element).width))
    assert.ok(Math.abs(widths.at(-1) - natural) < 0.5, `it ends at ${widths.at(-1)}, the natural width is ${natural}`)
    assert.equal(await page.locator(label).evaluate(element => element.getAttribute("style")), null)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("letters type in order, 55ms apart, with a short blur", async () => {
    const { context, page } = await open()
    // At ¼× the 55ms steps are 220ms, so a busy machine does not blur them.
    await page.locator("[data-test=speed]").click()
    await page.evaluate(() => window.motionText.morphText(document.querySelector("[data-test=morph]"), "Publishing"))
    await page.evaluate(() => {
      const element = document.querySelector("[data-test=morph]")
      const seen = {}
      const blurs = []
      const start = performance.now()
      const frame = () => {
        element.querySelectorAll("[data-motion-glyph]").forEach((glyph, index) => {
          const style = getComputedStyle(glyph)
          if (Number(style.opacity) > 0 && seen[index] === undefined) seen[index] = performance.now() - start
          if (style.filter.startsWith("blur")) blurs.push(style.filter)
        })
        if (element.querySelector("[data-motion-glyphs]")) requestAnimationFrame(frame)
        else window.typed = { seen, blurs }
      }
      frame()
    })
    await page.waitForFunction(() => window.typed, undefined, { timeout: 20_000 })
    const { seen, blurs } = await page.evaluate(() => window.typed)
    // "Publish" stays, so "i", "n", "g" type in.
    const times = [7, 8, 9].map(index => seen[index])
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]), `the letters come in order: ${times}`)
    const gaps = times.slice(1).map((time, index) => time - times[index])
    assert.ok(gaps.every(gap => gap > 160 && gap < 290), `about 220ms apart at ¼×: ${gaps}`)
    assert.ok(blurs.length > 0, "a typed letter blurs as it comes in")
    assert.equal(await page.locator("[data-test=morph]").textContent(), "Publishing")
    await context.close()
  })

  test("a second text in the middle of a morph continues from where it is", async () => {
    const { context, page } = await open()
    const selector = "[data-test=morph]"
    const trace = await sample(page, selector, element => Number.parseFloat(getComputedStyle(element).width))
    await page.evaluate(() => window.motionText.morphText(document.querySelector("[data-test=morph]"), "Publishing"))
    await page.waitForTimeout(110)
    const middle = await page.locator(selector).evaluate(element => Number.parseFloat(getComputedStyle(element).width))
    await page.evaluate(() => window.motionText.morphText(document.querySelector("[data-test=morph]"), "Published"))
    assert.equal(await page.locator(selector).textContent(), "Published")
    await settled(page, selector)
    await page.waitForTimeout(50)
    const widths = (await trace.stop()).map(([, value]) => value)
    assert.ok(maxStep(widths) < 6, `no jump at the second text: at most ${maxStep(widths)}px in one frame, ${middle}px in the middle`)
    const natural = await page.locator(selector).evaluate(element => Number.parseFloat(getComputedStyle(element).width))
    assert.ok(Math.abs(widths.at(-1) - natural) < 0.5, `it ends at ${widths.at(-1)}, the natural width is ${natural}`)
    assert.equal(await page.locator(selector).textContent(), "Published")
    await context.close()
  })

  test("MorphText morphs when its text changes", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=label-toggle]").click()
    await page.waitForFunction(() => document.querySelector("[data-test=morph-vue] [data-motion-glyphs]"))
    assert.equal(await page.locator("[data-test=morph-vue]").textContent(), "Copied")
    await settled(page, "[data-test=morph-vue] > [data-slot=morph-text]")
    assert.equal(await page.locator("[data-test=morph-vue]").textContent(), "Copied")
    await context.close()
  })

  test("a responsive MorphText updates to plain text while hidden", async () => {
    const { context, page } = await open({ viewport: { width: 480, height: 1400 } })
    const selector = "[data-test=morph-vue] > [data-slot=morph-text]"
    await page.addStyleTag({ content: `@media (max-width: 639px) { ${selector} { display: none } }` })
    const label = page.locator(selector)
    assert.equal(await label.isVisible(), false)
    await page.locator("[data-test=label-toggle]").click()
    assert.deepEqual(await label.evaluate(element => [...element.childNodes].map(node => [node.nodeType, node.textContent])), [[3, "Copied"]])
    await page.setViewportSize({ width: 900, height: 1400 })
    await label.waitFor({ state: "visible" })
    assert.equal(await label.textContent(), "Copied")
    await context.close()
  })
})

describe("icon swap", () => {
  test("CopyButton blurs the copy icon out, draws the check in, and rings once", async () => {
    const { context, errors, page } = await open()
    const button = page.locator("[data-test=copy]")
    const trace = await sample(page, "[data-test=copy]", (element) => {
      const icons = [...element.querySelectorAll("[data-slot=swap-icon] > [data-icon-key]")]
      const check = icons.at(-1)?.querySelector("path, polyline")
      return {
        icons: icons.length,
        leaving: icons.length > 1 ? getComputedStyle(icons[0]).filter : "",
        dash: check ? getComputedStyle(check).strokeDashoffset : "",
        ring: element.style.boxShadow,
      }
    })
    await button.click()
    await page.waitForTimeout(900)
    const values = (await trace.stop()).map(([, value]) => value)
    assert.ok(values.some(value => value.icons === 2 && value.leaving.startsWith("blur")), "the copy icon blurs out")
    const dashes = values.map(value => Number.parseFloat(value.dash)).filter(Number.isFinite)
    assert.ok(dashes.some(value => value > 0.5) && dashes.some(value => value > 0 && value < 0.5), `the check draws its stroke: ${dashes.slice(0, 12)}`)
    assert.equal(values.at(-1).icons, 1)
    assert.equal(values.at(-1).dash, "0px")
    const rings = values.map(value => value.ring)
    const first = rings.findIndex(Boolean)
    const last = rings.findLastIndex(Boolean)
    assert.ok(first >= 0, "the button rings")
    assert.ok(rings.slice(first, last + 1).every(Boolean), "it rings once, with no gap")
    assert.equal(rings.at(-1), "", "the ring is gone after")
    assert.match(rings[first + Math.floor((last - first) / 5)], /^0 0 0 [\d.]+px color-mix/)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a press of an icon-only CopyButton squashes its SwapIcon by 15% and keeps the button still", async () => {
    const { context, page } = await open()
    const box = await page.locator("[data-test=copy]").boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // The spring settles at a 15% squash of the icon.
    await page.waitForFunction(() => document.querySelector("[data-test=copy] > [data-slot=swap-icon]")?.style.scale === "0.85", undefined, { timeout: 15_000 })
    const own = await page.locator("[data-test=copy]").evaluate(element => getComputedStyle(element).scale)
    await page.mouse.up()
    assert.equal(own, "none")
    await context.close()
  })

  test("the spinner of a loading UButton draws in where the old icon blurs out", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=publish]", (element) => {
      const svgs = [...element.querySelectorAll(":scope > svg")]
      const spinner = svgs.find(svg => svg.matches(".animate-spin"))
      return { svgs: svgs.length, dash: spinner ? getComputedStyle(spinner.querySelector("path, circle")).strokeDashoffset : "" }
    })
    await page.locator("[data-test=publish]").click()
    await page.waitForTimeout(700)
    const values = (await trace.stop()).map(([, value]) => value)
    assert.ok(values.some(value => value.svgs === 2), "the old icon stays while it blurs out")
    const dashes = values.map(value => Number.parseFloat(value.dash)).filter(Number.isFinite)
    assert.ok(dashes.some(value => value > 0.5) && dashes.some(value => value > 0 && value < 0.5), `the spinner draws its stroke: ${dashes.slice(0, 12)}`)
    assert.equal(values.at(-1).svgs, 1)
    await context.close()
  })
})

describe("digit roll", () => {
  test("only the changed digit rolls, up when the count grows and down when it shrinks", async () => {
    const { context, page } = await open()
    const read = (element) => [...element.querySelectorAll("[data-motion-glyph]")].map(glyph => [glyph.dataset.motionGlyph, getComputedStyle(glyph).translate])
    for (const [button, value, sign] of [["count-up", "13", 1], ["count-down", "12", -1]]) {
      const trace = await sample(page, "[data-test=count]", read)
      await page.locator(`[data-test=${button}]`).click()
      assert.equal(await page.locator("[data-test=count]").textContent(), value)
      await settled(page, "[data-test=count]")
      const frames = (await trace.stop()).map(([, glyphs]) => glyphs)
      const moved = new Set(frames.flatMap(glyphs => glyphs.filter(([, translate]) => translate !== "none").map(([char]) => char)))
      assert.ok(!moved.has("1"), "the tens digit stays")
      const entering = frames.flatMap(glyphs => glyphs.filter(([char, translate]) => char === value.at(-1) && translate !== "none")).map(([, translate]) => Number.parseFloat(translate.split(" ")[1]))
      assert.ok(entering.length > 0 && Math.sign(entering[0]) === sign, `the new digit comes from ${sign > 0 ? "below" : "above"}: ${entering.slice(0, 4)}`)
    }
    await context.close()
  })

  test("a longer number adds a column with no jump, and ends at its natural width", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=roll]", element => Number.parseFloat(getComputedStyle(element).width))
    await page.evaluate(() => window.motionText.rollNumber(document.querySelector("[data-test=roll]"), 100))
    assert.equal(await page.locator("[data-test=roll]").textContent(), "100")
    await settled(page, "[data-test=roll]")
    await page.waitForTimeout(50)
    const widths = (await trace.stop()).map(([, value]) => value)
    assert.ok(maxStep(widths) < 4, `at most ${maxStep(widths)}px in one frame`)
    const natural = await page.locator("[data-test=roll]").evaluate(element => Number.parseFloat(getComputedStyle(element).width))
    assert.ok(Math.abs(widths.at(-1) - natural) < 0.5, `it ends at ${widths.at(-1)}, the natural width is ${natural}`)
    await context.close()
  })
})

describe("ring", () => {
  test("rings once: a 5px ring grows, fades, and is gone", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=ring]", element => element.style.boxShadow)
    await page.evaluate(() => window.motionText.ring(document.querySelector("[data-test=ring]")))
    await page.waitForTimeout(1000)
    const rings = (await trace.stop()).map(([, value]) => value)
    const spreads = rings.filter(Boolean).map(value => Number.parseFloat(value.match(/^0 0 0 ([\d.]+)px/)[1]))
    assert.ok(spreads.some(spread => spread >= 4.5 && spread <= 5.5), `it reaches 5px: ${spreads.map(spread => spread.toFixed(1))}`)
    assert.ok(spreads.every((spread, index) => index === 0 || spread >= spreads[index - 1]), "it only grows")
    assert.equal(rings.at(-1), "")
    await context.close()
  })
})

describe("reduced motion and opt-out", () => {
  test("reduced motion crossfades a label and a count in 150ms with no blur, travel, or ring", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=reduce]").click()
    const trace = await sample(page, "[data-test=morph]", element => [...element.querySelectorAll("[data-motion-glyph]")].map(glyph => getComputedStyle(glyph).filter))
    const started = await page.evaluate(() => {
      const element = document.querySelector("[data-test=morph]")
      const before = Number.parseFloat(getComputedStyle(element).width)
      window.motionText.morphText(element, "Publishing")
      return { before, after: Number.parseFloat(getComputedStyle(element).width) }
    })
    assert.ok(started.after > started.before + 10, `the width changes at once: ${started.before} to ${started.after}`)
    await settled(page, "[data-test=morph]")
    const filters = (await trace.stop()).flatMap(([, value]) => value)
    assert.ok(filters.every(filter => filter === "none"), "no letter blurs")
    const roll = await sample(page, "[data-test=roll]", element => [...element.querySelectorAll("[data-motion-glyph]")].map(glyph => getComputedStyle(glyph).translate))
    await page.evaluate(() => window.motionText.rollNumber(document.querySelector("[data-test=roll]"), 98))
    await settled(page, "[data-test=roll]")
    assert.ok((await roll.stop()).flatMap(([, value]) => value).every(translate => translate === "none"), "no digit travels")
    await page.evaluate(() => window.motionText.ring(document.querySelector("[data-test=ring]")))
    assert.equal(await page.locator("[data-test=ring]").evaluate(element => element.style.boxShadow), "")
    await context.close()
  })

  test("data-motion=\"none\" sets the text at once", async () => {
    const { context, page } = await open()
    const result = await page.evaluate(() => {
      const element = document.querySelector("[data-test=morph-off]")
      window.motionText.morphText(element, "Publishing")
      return { text: element.textContent, nodes: element.childNodes.length, style: element.getAttribute("style") }
    })
    assert.deepEqual(result, { text: "Publishing", nodes: 1, style: null })
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each change at ¼×", { timeout: 600_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const subjects = [
      { name: "publish-new", url: base, selector: "[data-test=publish]", hold: 4400 },
      { name: "copy-new", url: base, selector: "[data-test=copy]", hold: 2600 },
      { name: "copy-page-new", url: base, selector: "[data-test=copy-page]", hold: 2600 },
      { name: "count-new", url: base, selector: "[data-test=count-host]", click: "[data-test=count-up]", hold: 1800 },
    ]
    let today
    if (process.env.MOTION_TODAY) {
      today = await serve(process.env.MOTION_TODAY, join(process.env.MOTION_TODAY, "../../.."))
      const url = today.resolvedUrls.local[0]
      subjects.push(
        { name: "publish-today", url, selector: "[data-test=publish]", hold: 4400, cssRate: true },
        { name: "copy-today", url, selector: "[data-test=copy]", hold: 2600, cssRate: true },
        { name: "copy-page-today", url, selector: "[data-test=copy-page]", hold: 2600, cssRate: true },
        { name: "count-today", url, selector: "[data-test=count-host]", click: "[data-test=count-up]", hold: 1800, cssRate: true },
      )
    }
    if (process.env.MOTION_PROTOTYPE) {
      const url = pathToFileURL(process.env.MOTION_PROTOTYPE).href
      subjects.push(
        { name: "publish-prototype", url, selector: "#v-publish-btn", hold: 4400, prototype: true },
        { name: "count-prototype", url, selector: "#v-save-btn", hold: 1800, prototype: true },
      )
    }
    const summary = {}
    try {
      for (const subject of subjects) summary[subject.name] = await record(subject)
    }
    finally {
      await today?.close()
    }
    writeFileSync(join(recordDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  })
}

/** Clicks the subject and records it at ¼×: each frame that Chromium paints, as a video and one tiled image. */
async function record({ name, url, selector, click, hold, cssRate, prototype }) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 }, permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  await page.goto(url)
  if (!prototype) await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  // Only the rows of this file, the last three of the motion page, so every subject is on screen without a scroll.
  await page.addStyleTag({ content: `body { transform: scale(2); transform-origin: 0 0 }${prototype ? "" : " .page > section:not(:nth-last-child(-n+3)) { display: none }"}` })
  const element = page.locator(selector)
  // The body draws at twice its size, so scroll by its drawn box.
  await element.evaluate(node => node.scrollIntoView({ block: "center" }))
  if (prototype) {
    await element.evaluate((node) => {
      const section = node.closest("section")
      section.querySelector("[data-k=mode] [data-v=tactile]").click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    })
  }
  else if (cssRate) {
    // The page before this change animates with CSS only, so the browser slows it, and so do its timers through the layer.
    const cdp = await context.newCDPSession(page)
    await cdp.send("Animation.enable")
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.25 })
    await page.evaluate(() => document.querySelector("[data-test=speed]")?.click())
  }
  // The speed button is in a hidden row, so the page clicks it.
  else await page.evaluate(() => document.querySelector("[data-test=speed]").click())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)
  const box = await element.boundingBox()
  const pad = 24
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad), width: Math.ceil(box.width + 2 * pad + 80), height: Math.ceil(box.height + 2 * pad) }
  const dir = join(recordDir, name)
  mkdirSync(dir, { recursive: true })
  const cdp = await context.newCDPSession(page)
  const frames = []
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp })
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
  })
  const viewport = page.viewportSize()
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: viewport.width * 2, maxHeight: viewport.height * 2 })
  await page.waitForTimeout(400)
  if (click) await page.locator(click).click()
  else await element.click()
  await page.waitForTimeout(hold * 4)
  const end = Date.now() / 1000
  await cdp.send("Page.stopScreencast")
  await context.close()

  const first = Buffer.from(frames[0].data, "base64")
  const ratio = first.readUInt32BE(16) / viewport.width
  const crop = `crop=${Math.round(clip.width * ratio)}:${Math.round(clip.height * ratio)}:${Math.round(clip.x * ratio)}:${Math.round(clip.y * ratio)}`
  let list = ""
  frames.forEach((frame, index) => {
    writeFileSync(join(dir, `${index}.png`), Buffer.from(frame.data, "base64"))
    list += `file '${index}.png'\nduration ${((frames[index + 1]?.at ?? end) - frame.at).toFixed(4)}\n`
  })
  writeFileSync(join(dir, "frames.txt"), `${list}file '${frames.length - 1}.png'\n`)
  const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args])
  ffmpeg("-f", "concat", "-i", join(dir, "frames.txt"), "-vf", `${crop},pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-an", join(recordDir, `${name}.mp4`))
  const seconds = hold * 4 / 1000
  ffmpeg("-ss", "0.4", "-i", join(recordDir, `${name}.mp4`), "-vf", `fps=24/${seconds.toFixed(2)},tile=4x6:padding=4:color=white`, "-frames:v", "1", join(recordDir, `${name}.png`))
  return { frames: frames.length }
}
