// The select effect of the motion layer in Chromium: one indicator travels to the new item, stretches toward it, and
// settles. It runs the page `motion/` and reads the box of the indicator on every frame.
//
// Run: node --test test/browser/motion-select.browser.mjs
//
// Record mode: MOTION_RECORD=<dir> records each select at ¼× (UTabs with the CSS transition of Nuxt UI's theme and with
// the effect, the plain segmented group), and MOTION_PROTOTYPE=<file> adds the prototype's toolbar highlight. It writes
// one video and one tiled image per subject. MOTION_EXAMPLE_URL=<docs page> adds the docs Example switch as it is on that
// page. It needs ffmpeg.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { vitehubTheme } from "../../src/theme.ts"

const root = fileURLToPath(new URL("./motion/", import.meta.url))
const nuxtUIRequire = createRequire(fileURLToPath(import.meta.resolve("@nuxt/ui/vite")))

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [vue(), nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme })],
  resolve: { alias: [{ find: /^@iconify\/vue$/, replacement: nuxtUIRequire.resolve("@iconify/vue") }] },
  root,
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open(query = "", options = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2, ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

// The groups of the page, and how to find the indicator in each: Nuxt UI's tab indicator, the copy of a plain group, or
// the dot of the checked radio.
const groups = {
  tabs: { group: "[data-test=tabs] [role=tablist]", indicator: "[data-slot=indicator]" },
  plain: { group: "[data-test=plain-tabs]", indicator: "[data-motion-copy]" },
  segment: { group: "[data-test=plain-segment]", indicator: "[data-motion-copy]" },
  off: { group: "[data-test=select-off]", indicator: "[data-motion-copy]" },
  radio: { group: "[data-test=radio]", indicator: "[role=radio][aria-checked=true] [data-slot=indicator]" },
  hover: { group: "[data-test=hover-grid]", indicator: "[data-motion-indicator]" },
}

/**
 * Starts to record, on every frame, the box of the indicator of a group and what the effect wrote on it. It reads after
 * the frame callbacks and layout, just before paint, as a ResizeObserver does: a frame callback would read before the
 * effect writes, and see the new place of the indicator before the effect moves it back.
 */
async function sample(page, name) {
  await page.evaluate(({ name, group, indicator }) => {
    const frames = []
    let running = true
    const probe = document.body.appendChild(document.createElement("div"))
    probe.style.cssText = "position:fixed;top:0;left:0;height:1px;width:1px;pointer-events:none"
    const read = () => {
      const element = document.querySelector(group)?.querySelector(indicator)
      if (element) {
        const rect = element.getBoundingClientRect()
        frames.push({ left: rect.left, right: rect.right, width: rect.width, height: rect.height, scale: element.style.scale, translate: element.style.translate })
      }
      else frames.push(null)
    }
    const observer = new ResizeObserver(read)
    observer.observe(probe)
    const tick = () => {
      if (!running) return
      probe.style.width = probe.style.width === "1px" ? "2px" : "1px"
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.stopSample ??= {}
    window.stopSample[name] = () => {
      running = false
      observer.disconnect()
      probe.remove()
      return frames.slice(1)
    }
  }, { name, ...groups[name] })
  return { stop: () => page.evaluate(name => window.stopSample[name](), name) }
}

function itemBox(page, selector) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width }
  })
}

/**
 * Waits until the effect has cleared what it wrote in a group: no inline `translate` or `scale`, and no copy. The effect
 * starts on the frame after a selection, so it first waits for two frames.
 */
async function settled(page, name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(({ group }) => {
    const root = document.querySelector(group)
    return root && !root.querySelector("[data-motion-copy]") && ![...root.querySelectorAll("*")].some(node => node.style?.scale || node.style?.translate)
  }, groups[name], { timeout: 5000 })
}

const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance

describe("select one of many", async () => {
  test("the UTabs indicator travels to the new tab, stretches on the way, and settles under it", async () => {
    const { context, errors, page } = await open()
    const tabs = page.locator("[data-test=tabs] [role=tab]")
    const from = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=0")
    const to = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=2")
    // The indicator gets no CSS transition of its own.
    assert.equal(await page.locator("[data-test=tabs] [data-slot=indicator]").evaluate(node => getComputedStyle(node).transitionProperty), "none")
    const trace = await sample(page, "tabs")
    await tabs.nth(2).click()
    await settled(page, "tabs")
    await page.waitForTimeout(50)
    const frames = (await trace.stop()).filter(Boolean)
    const moving = frames.filter(frame => frame.translate)
    assert.ok(moving.length > 5, `the indicator moves over ${moving.length} frames`)
    // Mid-flight it is wider than the wider of the two tabs: it stretched toward the new one.
    const widest = Math.max(...moving.map(frame => frame.width))
    assert.ok(widest > Math.max(from.width, to.width) * 1.1, `the widest frame is ${widest}px, the tabs are ${from.width}px and ${to.width}px`)
    // The leading edge goes first: in the first frames the right edge has moved further than the left one.
    const early = moving[Math.min(3, moving.length - 1)]
    assert.ok(early.right - from.right > early.left - from.left, "the right edge leads")
    const last = frames.at(-1)
    assert.ok(near(last.left, to.left) && near(last.width, to.width), `it ends under the new tab: ${JSON.stringify(last)} ${JSON.stringify(to)}`)
    assert.equal(last.scale, "")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a fast second selection turns the indicator with no jump", async () => {
    const { context, page } = await open()
    const tabs = page.locator("[data-test=tabs] [role=tab]")
    const first = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=0")
    const middle = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=1")
    const end = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=2")
    const trace = await sample(page, "tabs")
    await tabs.nth(2).click()
    await page.waitForTimeout(60)
    await tabs.nth(1).click()
    await settled(page, "tabs")
    const frames = (await trace.stop()).filter(Boolean)
    const centers = frames.map(frame => (frame.left + frame.right) / 2)
    const steps = centers.slice(1).map((center, index) => Math.abs(center - centers[index]))
    const distance = Math.abs((end.left + end.right) / 2 - (first.left + first.right) / 2)
    assert.ok(Math.max(...steps) < distance * 0.5, `the largest step between two frames is ${Math.max(...steps)}px of ${distance}px`)
    const last = frames.at(-1)
    assert.ok(near(last.left, middle.left) && near(last.width, middle.width), "it ends under the second choice")
    await context.close()
  })

  test("arrow keys move the indicator the same way", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=tabs] [role=tab] >> nth=0").focus()
    const to = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=1")
    const trace = await sample(page, "tabs")
    await page.keyboard.press("ArrowRight")
    await settled(page, "tabs")
    const frames = (await trace.stop()).filter(Boolean)
    assert.ok(frames.filter(frame => frame.translate).length > 5, "the indicator travels")
    assert.ok(near(frames.at(-1).left, to.left), "it ends under the next tab")

    // A plain group with its own arrow keys.
    await page.locator("[data-test=plain-tabs] [aria-selected=true]").focus()
    const plain = await sample(page, "plain")
    await page.keyboard.press("ArrowRight")
    await page.waitForTimeout(100)
    assert.ok((await plain.stop()).some(frame => frame?.translate), "the copy of the plain group travels")
    await settled(page, "plain")
    await context.close()
  })

  test("a plain group moves a copy of the selected look, stretched, and gives the look back to the item", async () => {
    const { context, page } = await open()
    const from = await itemBox(page, "[data-test=plain-segment] [role=radio] >> nth=0")
    const to = await itemBox(page, "[data-test=plain-segment] [role=radio] >> nth=1")
    const trace = await sample(page, "segment")
    await page.locator("[data-test=plain-segment] [role=radio] >> nth=1").click()
    await page.waitForTimeout(40)
    // While the copy flies, the new item hides its own look and the group is a stacking context.
    const during = await page.locator("[data-test=plain-segment]").evaluate((group) => {
      const item = group.querySelector("[aria-checked=true]")
      return { hidden: item.getAttribute("data-motion-select-hidden"), background: getComputedStyle(item).backgroundColor, isolation: getComputedStyle(group).isolation }
    })
    assert.equal(during.hidden, "background shadow")
    assert.equal(during.background, "rgba(0, 0, 0, 0)")
    assert.equal(during.isolation, "isolate")
    await settled(page, "segment")
    const frames = (await trace.stop()).filter(Boolean)
    const widest = Math.max(...frames.map(frame => frame.width))
    assert.ok(widest > Math.max(from.width, to.width) * 1.1, `the copy stretched to ${widest}px`)
    const after = await page.locator("[data-test=plain-segment] [aria-checked=true]").evaluate(item => ({ hidden: item.hasAttribute("data-motion-select-hidden"), background: getComputedStyle(item).backgroundColor }))
    assert.equal(after.hidden, false)
    assert.notEqual(after.background, "rgba(0, 0, 0, 0)")
    assert.equal(await page.locator("[data-test=plain-segment]").evaluate(group => getComputedStyle(group).isolation), "auto")
    await context.close()
  })

  test("the dot of URadioGroup and the mark of a data-motion-select group travel", async () => {
    const { context, page } = await open()
    const radio = await sample(page, "radio")
    await page.locator("[data-test=radio] [role=radio]").nth(1).click()
    await settled(page, "radio")
    assert.ok((await radio.stop()).some(frame => frame?.translate), "the radio dot travels")

    const hover = page.locator("[data-test=hover-grid] li")
    await hover.nth(0).hover()
    await page.waitForTimeout(100)
    const trace = await sample(page, "hover")
    await hover.nth(2).hover()
    await settled(page, "hover")
    const frames = (await trace.stop()).filter(Boolean)
    assert.ok(frames.some(frame => frame.translate), "the mark travels to the hovered item")
    const to = await itemBox(page, "[data-test=hover-grid] li >> nth=2")
    assert.ok(near(frames.at(-1).left, to.left), "it ends on the hovered item")
    await context.close()
  })

  test("reduced motion moves the indicator at once, with no stretch", async () => {
    for (const forced of [false, true]) {
      const { context, page } = forced ? await open() : await open("", { reducedMotion: "reduce" })
      if (forced) await page.locator("[data-test=reduce]").click()
      const to = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=2")
      const tabs = await sample(page, "tabs")
      const segment = await sample(page, "segment")
      await page.locator("[data-test=tabs] [role=tab] >> nth=2").click()
      await page.locator("[data-test=plain-segment] [role=radio] >> nth=1").click()
      await page.waitForTimeout(300)
      const tabFrames = (await tabs.stop()).filter(Boolean)
      const segmentFrames = await segment.stop()
      assert.ok(tabFrames.every(frame => !frame.scale && !frame.translate), "nothing written on the tab indicator")
      assert.ok(near(tabFrames.at(-1).left, to.left), "the tab indicator is in its new place")
      assert.ok(segmentFrames.every(frame => frame === null), "no copy in the plain group")
      await context.close()
    }
  })

  test("data-motion=none turns the effect off", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "off")
    await page.locator("[data-test=select-off] [role=tab] >> nth=1").click()
    await page.waitForTimeout(300)
    assert.ok((await trace.stop()).every(frame => frame === null), "no copy")
    assert.equal(await page.locator("[data-test=select-off] [aria-selected=true]").getAttribute("data-motion-select-hidden"), null)
    await context.close()
  })

  test("a resize keeps the indicator in place with no motion", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=tabs] [role=tab] >> nth=1").click()
    await settled(page, "tabs")
    const trace = await sample(page, "tabs")
    await page.locator("[data-test=tabs] [role=tab] >> nth=0").evaluate((tab) => {
      tab.querySelector("[data-slot=label]").textContent = "A much longer overview"
    })
    await page.setViewportSize({ width: 700, height: 900 })
    await page.waitForTimeout(300)
    const frames = (await trace.stop()).filter(Boolean)
    assert.ok(frames.every(frame => !frame.translate && !frame.scale), "nothing written while the layout changes")
    const to = await itemBox(page, "[data-test=tabs] [role=tab] >> nth=1")
    assert.ok(near(frames.at(-1).left, to.left), "it stays under the selected tab")
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each select at ¼×", { timeout: 300_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const subjects = [
      { name: "utabs-today", query: "?mode=today", area: "[data-test=tabs]", click: "[data-test=tabs] [role=tab] >> nth=2", back: "[data-test=tabs] [role=tab] >> nth=0", mode: "css" },
      { name: "utabs-spring", query: "", area: "[data-test=tabs]", click: "[data-test=tabs] [role=tab] >> nth=2", back: "[data-test=tabs] [role=tab] >> nth=0", mode: "spring" },
      { name: "segment-spring", query: "", area: "[data-test=plain-segment]", click: "[data-test=plain-segment] [role=radio] >> nth=1", back: "[data-test=plain-segment] [role=radio] >> nth=0", mode: "spring" },
    ]
    // MOTION_EXAMPLE_URL: a docs page with a `:::example`, such as the live site, for the Example switch before the effect.
    if (process.env.MOTION_EXAMPLE_URL) {
      subjects.push({ name: "example-today", url: process.env.MOTION_EXAMPLE_URL, area: ".vh-seg >> nth=0", click: ".vh-seg >> nth=0 >> [data-view=code]", back: ".vh-seg >> nth=0 >> [data-view=preview]", mode: "css" })
    }
    if (process.env.MOTION_PROTOTYPE) {
      const url = pathToFileURL(process.env.MOTION_PROTOTYPE).href
      subjects.push({ name: "prototype-toolbar", url, area: "#v-toolbar-bar", hover: "#v-toolbar-bar button >> nth=0", click: "#v-toolbar-bar button >> nth=3", mode: "prototype" })
    }
    const warm = await open()
    await warm.context.close()
    const summary = {}
    for (const subject of subjects) summary[subject.name] = await record(subject)
    writeFileSync(join(recordDir, "select-summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  })
}

/** Selects an item at ¼× and records each frame that Chromium paints, then plays it back as a video and a tiled image. */
async function record({ name, query, url, area, click, back, hover, mode }) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  if (url) await page.goto(url, { waitUntil: "networkidle" })
  else {
    await page.goto(`${base}${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  }
  await page.addStyleTag({ content: "body { transform: scale(2); transform-origin: 0 0 }" })
  // A headless browser draws no pointer. This arrow's tip follows the mouse, so the clip shows what presses.
  await page.evaluate(() => {
    const tip = document.documentElement.appendChild(document.createElement("div"))
    tip.innerHTML = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20' width='28' height='40'><path d='M1 1v16l4-4 3 6 2-1-3-6h6z' fill='#111' stroke='#fff' stroke-width='1.2' stroke-linejoin='round'/></svg>"
    tip.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none"
    addEventListener("mousemove", event => (tip.style.translate = `${event.clientX}px ${event.clientY}px`), { capture: true })
  })
  const region = page.locator(area)
  await region.scrollIntoViewIfNeeded()
  if (mode === "prototype") {
    // The toolbar section has its own Today/Tactile and 1×/¼× switches. Its highlight follows the pointer.
    await region.evaluate((node) => {
      const section = node.closest("section")
      section.querySelector("[data-k=mode] [data-v=tactile]").click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    })
    const start = await page.locator(hover).boundingBox()
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  }
  else if (mode === "css") {
    // A CSS transition: the browser slows it.
    const cdp = await context.newCDPSession(page)
    await cdp.send("Animation.enable")
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.25 })
  }
  else await page.locator("[data-test=speed]").click()
  if (back) await page.locator(back).click()
  if (mode !== "prototype") await page.mouse.move(0, 0)
  await page.waitForTimeout(3000)

  const box = await region.boundingBox()
  const pad = 24
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad), width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad) }
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
  await page.waitForTimeout(500)
  const target = await page.locator(click).boundingBox()
  // The clip starts 0.6s before the pointer moves, so it has no idle frames from a slow machine at its start.
  const startAt = Date.now() / 1000 - 0.6
  if (mode === "prototype") await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 })
  else {
    // A keyboard-free click, as a person does it: the pointer is already over the item.
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.mouse.up()
  }
  await page.waitForTimeout(4000)
  const end = Date.now() / 1000
  await cdp.send("Page.stopScreencast")
  await context.close()

  const first = Buffer.from(frames[0].data, "base64")
  const ratio = first.readUInt32BE(16) / viewport.width
  const crop = `crop=${Math.round(clip.width * ratio)}:${Math.round(clip.height * ratio)}:${Math.round(clip.x * ratio)}:${Math.round(clip.y * ratio)}`
  const firstShown = Math.max(0, frames.findLastIndex(frame => frame.at <= startAt))
  frames.splice(0, firstShown)
  frames[0].at = Math.max(frames[0].at, startAt)
  let list = ""
  frames.forEach((frame, index) => {
    writeFileSync(join(dir, `${index}.png`), Buffer.from(frame.data, "base64"))
    list += `file '${index}.png'\nduration ${((frames[index + 1]?.at ?? end) - frame.at).toFixed(4)}\n`
  })
  writeFileSync(join(dir, "frames.txt"), `${list}file '${frames.length - 1}.png'\n`)
  const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args])
  ffmpeg("-f", "concat", "-i", join(dir, "frames.txt"), "-vf", `${crop},pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-an", join(recordDir, `${name}.mp4`))
  ffmpeg("-ss", "0.6", "-i", join(recordDir, `${name}.mp4`), "-vf", "fps=24/3.6,tile=6x4:padding=4:color=white", "-frames:v", "1", join(recordDir, `${name}.png`))
  return { frames: frames.length }
}
