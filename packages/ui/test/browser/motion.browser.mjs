// The motion layer of `@vite-hub/ui/motion` in Chromium. It runs the page `motion/`, which renders every role with
// Nuxt UI components and with plain elements, and checks the computed `scale` of each press frame by frame.
//
// Run: pnpm --filter @vite-hub/ui test:motion
//
// Record mode: MOTION_RECORD=<dir> also records each press at ¼× (the spring press, and the 150ms `scale-[.97]` press
// of the theme before the layer), and writes the frames, one tiled image, one video, and the `scale` of each frame.
// MOTION_PROTOTYPE=<file> adds the same press from the prototype HTML file, to compare. It needs ffmpeg.
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

/** The computed `scale` of the element that a press of `test` squashes: the icon of an icon-only control, or itself. */
function scaleOf(page, testId) {
  return page.locator(`[data-test="${testId}"]`).evaluate((element) => {
    const target = element.childElementCount === 1 && !element.textContent.trim() ? element.firstElementChild : element
    const value = getComputedStyle(target).scale
    return value === "none" ? 1 : Number(value.split(" ")[0])
  })
}

/** Records the `scale` of the pressed element on every frame until `stop()`. */
async function sample(page, testId) {
  await page.locator(`[data-test="${testId}"]`).evaluate((element) => {
    const target = element.childElementCount === 1 && !element.textContent.trim() ? element.firstElementChild : element
    const values = []
    let running = true
    const read = () => {
      const value = getComputedStyle(target).scale
      values.push(value === "none" ? 1 : Number(value.split(" ")[0]))
      if (running) requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.stopSample = () => {
      running = false
      return values
    }
  })
  return { stop: () => page.evaluate(() => window.stopSample()) }
}

async function pointerDown(page, testId) {
  const box = await page.locator(`[data-test="${testId}"]`).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

/** The lowest `scale` while the pointer is down for 150ms, and the `scale` once the press has settled. */
async function press(page, testId) {
  await pointerDown(page, testId)
  await page.waitForTimeout(150)
  const down = await scaleOf(page, testId)
  await page.mouse.up()
  await page.waitForFunction(id => {
    const element = document.querySelector(`[data-test="${id}"]`) ?? document.querySelector("motion-shadow-button").shadowRoot.querySelector(`[data-test="${id}"]`)
    const target = element.childElementCount === 1 && !element.textContent.trim() ? element.firstElementChild : element
    return !target.style.scale
  }, testId, { timeout: 5000 })
  return { down, settled: await scaleOf(page, testId) }
}

const roles = ["button", "link", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "checkbox"]

describe("press by role", async () => {
  test("a pressed UButton squashes, springs back past rest, and clears its scale", async () => {
    const { context, errors, page } = await open()
    const trace = await sample(page, "button")
    await pointerDown(page, "button")
    await page.waitForTimeout(150)
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector("[data-test=button]").style.scale, undefined, { timeout: 5000 })
    await page.waitForTimeout(50)
    const values = await trace.stop()
    const low = Math.min(...values)
    // UButton sm is 28px high, so it squashes by 5%.
    assert.ok(low < 0.96 && low > 0.94, `the press squashes to about 0.95, not ${low}`)
    assert.ok(Math.max(...values) > 1.005, `the release passes rest, up to ${Math.max(...values)}`)
    assert.equal(values.at(-1), 1)
    assert.equal(await page.locator("[data-test=button]").evaluate(element => element.style.scale), "")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a fast second press continues from where the first one is, with no jump", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "button-outline")
    for (let index = 0; index < 3; index++) {
      await pointerDown(page, "button-outline")
      await page.waitForTimeout(40)
      await page.mouse.up()
      await page.waitForTimeout(40)
    }
    await page.waitForTimeout(800)
    const values = await trace.stop()
    // A press that started again from rest would show 1 between the presses. The only 1s are before and after.
    const first = values.findIndex(value => value !== 1)
    const last = values.findLastIndex(value => value !== 1)
    assert.ok(first >= 0 && Math.min(...values) < 0.98, "the presses squash")
    assert.deepEqual(values.slice(first, last + 1).filter(value => value === 1), [])
    // One frame moves at most 32ms of the spring, less than the full squash of 5%.
    const steps = values.slice(1).map((value, index) => Math.abs(value - values[index]))
    assert.ok(Math.max(...steps) < 0.04, `the largest step between two frames is ${Math.max(...steps)}`)
    await context.close()
  })

  test("each Nuxt UI control and each role squashes", async () => {
    const { context, page } = await open()
    const ids = ["button-large", "button-link", ...roles.map(role => `role-${role}`), "plain-button", "plain-a", "plain-summary"]
    for (const id of ids) {
      const { down, settled } = await press(page, id)
      assert.ok(down < 0.99, `${id} squashes (${down})`)
      assert.equal(settled, 1, `${id} settles at rest`)
    }
    for (const selector of ["button[role=tab]", "button[role=switch]", "button[role=checkbox]", "button[role=radio]"]) {
      const element = page.locator(selector).first()
      const box = await element.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(150)
      const scale = await element.evaluate(node => getComputedStyle(node).scale)
      await page.mouse.up()
      assert.notEqual(scale, "none", `${selector} squashes`)
    }
    await context.close()
  })

  test("an icon-only button squashes its icon by 15%", async () => {
    const { context, page } = await open()
    await pointerDown(page, "button-icon")
    await page.waitForTimeout(150)
    const icon = await scaleOf(page, "button-icon")
    const own = await page.locator("[data-test=button-icon]").evaluate(element => getComputedStyle(element).scale)
    await page.mouse.up()
    assert.ok(icon < 0.87 && icon > 0.84, `the icon squashes to about 0.85, not ${icon}`)
    assert.equal(own, "none")
    await context.close()
  })

  test("Space and Enter press the control that has focus", async () => {
    const { context, page } = await open()
    for (const key of ["Space", "Enter"]) {
      await page.locator("[data-test=plain-button]").focus()
      await page.keyboard.down(key)
      await page.waitForTimeout(150)
      const down = await scaleOf(page, "plain-button")
      await page.keyboard.up(key)
      assert.ok(down < 0.99, `${key} squashes (${down})`)
      await page.waitForFunction(() => !document.querySelector("[data-test=plain-button]").style.scale)
    }
    await context.close()
  })

  test("disabled controls, controls inside data-motion=none, controls with their own scale transition, and plain text do not squash", async () => {
    const { context, page } = await open()
    for (const id of ["button-disabled", "plain-disabled", "aria-disabled", "opt-out", "own-press"]) {
      await pointerDown(page, id)
      await page.waitForTimeout(150)
      const down = await scaleOf(page, id)
      await page.mouse.up()
      assert.equal(down, 1, `${id} stays still`)
    }
    // A press on a span in a button squashes the button, not the span.
    await pointerDown(page, "inner-span")
    await page.waitForTimeout(150)
    assert.equal(await page.locator("[data-test=inner-span]").evaluate(node => getComputedStyle(node).scale), "none")
    assert.ok(await scaleOf(page, "not-a-control-parent") < 0.99)
    await page.mouse.up()
    await context.close()
  })

  test("reduced motion turns the press off, from the system setting and from forceReducedMotion", async () => {
    const system = await open("", { reducedMotion: "reduce" })
    await pointerDown(system.page, "button")
    await system.page.waitForTimeout(150)
    assert.equal(await scaleOf(system.page, "button"), 1)
    await system.page.mouse.up()
    // The layer follows a live change of the setting.
    await system.page.emulateMedia({ reducedMotion: "no-preference" })
    const { down } = await press(system.page, "button")
    assert.ok(down < 0.99, "the press comes back when reduced motion turns off")
    await system.context.close()

    const forced = await open()
    await forced.page.locator("[data-test=reduce]").click()
    await pointerDown(forced.page, "button")
    await forced.page.waitForTimeout(150)
    assert.equal(await scaleOf(forced.page, "button"), 1)
    await forced.page.mouse.up()
    await forced.context.close()
  })

  test("a button in a shadow root gets the press", async () => {
    const { context, page } = await open()
    const button = page.locator("motion-shadow-button button")
    const box = await button.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(150)
    const down = await button.evaluate(node => getComputedStyle(node).scale)
    await page.mouse.up()
    assert.ok(Number(down) < 0.99, `the shadow button squashes (${down})`)
    await context.close()
  })

  test("the ¼× speed makes the press four times slower", async () => {
    const { context, page } = await open()
    const time = async () => {
      await pointerDown(page, "button-outline")
      await page.waitForTimeout(150)
      const start = Date.now()
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector("[data-test=button-outline]").style.scale, undefined, { timeout: 10_000 })
      return Date.now() - start
    }
    const real = await time()
    await page.locator("[data-test=speed]").click()
    await page.waitForTimeout(400)
    const slow = await time()
    assert.ok(slow > real * 2.5, `¼× takes ${slow}ms, 1× takes ${real}ms`)
    await context.close()
  })

  test("the theme no longer squashes UButton with CSS", async () => {
    const { context, page } = await open()
    const transition = await page.locator("[data-test=button]").evaluate(element => getComputedStyle(element).transitionProperty)
    assert.doesNotMatch(transition, /transform|scale/)
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each press at ¼×", { timeout: 300_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const subjects = [
      { name: "ubutton-spring", query: "", selector: "[data-test=button-outline]" },
      { name: "ubutton-today", query: "?mode=today", selector: "[data-test=button-outline]", cssRate: true },
      { name: "tab-spring", query: "", selector: "button[role=tab] >> nth=1" },
      { name: "tab-today", query: "?mode=today", selector: "button[role=tab] >> nth=1", cssRate: true },
      { name: "icon-spring", query: "", selector: "[data-test=button-icon]" },
    ]
    if (process.env.MOTION_PROTOTYPE) {
      const url = pathToFileURL(process.env.MOTION_PROTOTYPE).href
      subjects.push(
        { name: "prototype-tactile", url, selector: "#v-duplicate-btn", prototype: "tactile" },
        { name: "prototype-today", url, selector: "#v-duplicate-btn", prototype: "today" },
        { name: "prototype-icon", url, selector: "#v-toolbar-bar button >> nth=0", prototype: "tactile" },
      )
    }
    // The first visit can reload the page while Vite optimizes dependencies, so warm it up first.
    const warm = await open()
    await warm.context.close()
    const summary = {}
    for (const subject of subjects) summary[subject.name] = await record(subject)
    writeFileSync(join(recordDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  })
}

/**
 * Presses the element for 120ms of motion time and records it at ¼×: each frame that Chromium paints, and the `scale` of
 * the element on every frame, as motion time in milliseconds.
 */
async function record({ name, query, url, selector, cssRate, prototype }) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  if (url) await page.goto(url)
  else {
    await page.goto(`${base}${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  }
  // The screencast sends CSS pixels, so the page draws at twice its size. A transform on the body leaves the layout,
  // and the heights that the press reads, as they are.
  await page.addStyleTag({ content: "body { transform: scale(2); transform-origin: 0 0 }" })
  const element = page.locator(selector)
  await element.scrollIntoViewIfNeeded()
  if (prototype) {
    // The section of the element has its own Today/Tactile and 1×/¼× switches.
    await element.evaluate((node, mode) => {
      const section = node.closest("section")
      section.querySelector(`[data-k=mode] [data-v=${mode}]`).click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    }, prototype)
  }
  else if (cssRate) {
    // The CSS press of the theme is a transition, so the browser slows it.
    const cdp = await context.newCDPSession(page)
    await cdp.send("Animation.enable")
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.25 })
  }
  else await page.locator("[data-test=speed]").click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)

  const box = await element.boundingBox()
  const pad = 20
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad), width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad) }
  // The trace reads what the press writes: `scale` from the layer, `transform` from CSS and from the prototype.
  await element.evaluate((node) => {
    const target = node.childElementCount === 1 && !node.textContent.trim() ? node.firstElementChild : node
    const values = []
    const start = performance.now()
    let running = true
    const read = () => {
      const style = getComputedStyle(target)
      const matrix = style.transform === "none" ? 1 : new DOMMatrix(style.transform).a
      const scale = style.scale === "none" ? 1 : Number(style.scale.split(" ")[0])
      values.push([Math.round((performance.now() - start) / 4), Number((matrix * scale).toFixed(4))])
      if (running) requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.stopTrace = () => {
      running = false
      return values
    }
  })
  const dir = join(recordDir, name)
  mkdirSync(dir, { recursive: true })
  // Chromium's screencast sends a lossless frame each time the page paints, so a busy machine drops no motion.
  const cdp = await context.newCDPSession(page)
  const frames = []
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp })
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
  })
  const viewport = page.viewportSize()
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: viewport.width * 2, maxHeight: viewport.height * 2 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.waitForTimeout(700)
  await page.mouse.down()
  // 120ms of motion time is 480ms at ¼×.
  await page.waitForTimeout(480)
  await page.mouse.up()
  await page.waitForTimeout(2800)
  const end = Date.now() / 1000
  await cdp.send("Page.stopScreencast")
  const trace = await page.evaluate(() => window.stopTrace())
  await context.close()

  // Each frame holds until the next one. The crop is the clip, in the pixels of the frame.
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
  // The tiled image: 24 frames at even times from the press to the rest, 8 per row.
  ffmpeg("-ss", "0.6", "-i", join(recordDir, `${name}.mp4`), "-vf", "fps=24/2.4,tile=8x3:padding=4:color=white", "-frames:v", "1", join(recordDir, `${name}.png`))
  writeFileSync(join(recordDir, `${name}.trace.json`), `${JSON.stringify(trace)}\n`)
  const values = trace.map(([, value]) => value)
  return { frames: frames.length, min: Math.min(...values), max: Math.max(...values) }
}
