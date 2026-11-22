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
  // The element that a press of `data-test=<id>` squashes: the icon of an icon-only control, or itself, also in the
  // shadow root of the page.
  await page.addInitScript(() => {
    window.pressTarget = (id) => {
      const element = document.querySelector(`[data-test="${id}"]`) ?? document.querySelector("motion-shadow-button")?.shadowRoot?.querySelector(`[data-test="${id}"]`)
      return element.childElementCount === 1 && !element.textContent.trim() ? element.firstElementChild : element
    }
  })
  await page.goto(`${base}${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

// The checks wait for what the spring writes, never for a fixed time. On a busy machine a frame can take far more than
// 16ms, and the layer moves each spring by at most 32ms of motion per frame, so wall-clock waits drift from the spring.

/** Waits until the inline `scale` that the press writes on `data-test=<id>` passes `check`, a function of the number. */
function waitForScale(page, testId, check) {
  return page.waitForFunction(([id, source]) => {
    const value = window.pressTarget(id).style.scale
    return new Function("scale", `return (${source})(scale)`)(value === "" ? 1 : Number(value))
  }, [testId, check.toString()], { timeout: 15_000 })
}

/** Waits until the press on `data-test=<id>` has settled and removed its `scale`. */
function waitForRest(page, testId) {
  return page.waitForFunction(id => window.pressTarget(id).style.scale === "", testId, { timeout: 15_000 })
}

/** Waits for `count` frames of the page, enough for any spring to write its first value. */
function frames(page, count = 10) {
  return page.evaluate(count => new Promise((resolve) => {
    const next = left => left ? requestAnimationFrame(() => next(left - 1)) : resolve()
    next(count)
  }), count)
}

/** The computed `scale` of the element that a press of `test` squashes: the icon of an icon-only control, or itself. */
function scaleOf(page, testId) {
  return page.locator(`[data-test="${testId}"]`).evaluate((element) => {
    const target = element.childElementCount === 1 && !element.textContent.trim() ? element.firstElementChild : element
    const value = getComputedStyle(target).scale
    return value === "none" ? 1 : Number(value.split(" ")[0])
  })
}

/**
 * Records the `scale` of the pressed element on every frame until `stop()`: the computed number, and the inline value
 * that the layer writes, which is empty only at rest. For each pointer down on it, it records the index of the next frame
 * and the inline `scale` at that moment.
 */
async function sample(page, testId) {
  await page.evaluate((id) => {
    const target = window.pressTarget(id)
    const values = []
    const inline = []
    const downs = []
    window.sampled = values
    target.closest("[data-test]").addEventListener("pointerdown", () => downs.push({ index: values.length, scale: target.style.scale }))
    let running = true
    const read = () => {
      const value = getComputedStyle(target).scale
      values.push(value === "none" ? 1 : Number(value.split(" ")[0]))
      inline.push(target.style.scale)
      if (running) requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.stopSample = () => {
      running = false
      return { downs, inline, values }
    }
  }, testId)
  return { stop: () => page.evaluate(() => window.stopSample()) }
}

async function boxInView(locator) {
  await locator.scrollIntoViewIfNeeded()
  return locator.boundingBox()
}

async function pointerDown(page, testId) {
  const box = await boxInView(page.locator(`[data-test="${testId}"]`))
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
}

/** The `scale` once the pressed element has squashed, and the `scale` once the press has settled. */
async function press(page, testId) {
  await pointerDown(page, testId)
  await waitForScale(page, testId, scale => scale < 0.99)
  const down = await scaleOf(page, testId)
  await page.mouse.up()
  await waitForRest(page, testId)
  return { down, settled: await scaleOf(page, testId) }
}

// A switch grows its knob instead of a press. test/browser/motion-toggle.browser.mjs checks it.
const roles = ["button", "link", "tab", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "checkbox"]

describe("press by role", async () => {
  test("a squashing button keeps native activation at its original edge, but a drag outside does not activate", async () => {
    const { context, page } = await open()
    try {
      const control = page.getByRole("button", { name: "Publish", exact: true })
      await control.evaluate((node) => {
        node.style.width = "120px"
        node.dataset.clicks = "0"
        node.addEventListener("click", () => { node.dataset.clicks = String(Number(node.dataset.clicks) + 1) })
      })
      const { x, y, width, height } = await control.boundingBox()
      const center = y + height / 2
      for (const [start, end, clicks] of [
        [x + width - 1, x + width - 1, "1"],
        [x + width / 2, x + width - 1, "2"],
        [x + width / 2, x + width + 1, "2"],
      ]) {
        await page.mouse.move(start, center)
        await page.mouse.down()
        if (start === end) await frames(page)
        else {
          await waitForScale(page, "button", scale => scale < 0.99)
          await page.mouse.move(end, center)
        }
        await page.mouse.up()
        assert.equal(await control.getAttribute("data-clicks"), clicks)
      }
    }
    finally {
      await context.close()
    }
  })

  test("an ordinary inline link activates without changing layout or squashing", async () => {
    const { context, page } = await open()
    try {
      const link = page.locator("[data-test=inline-a]")
      assert.equal(await link.evaluate(node => getComputedStyle(node).display), "inline")
      await pointerDown(page, "inline-a")
      await frames(page)
      assert.equal(await link.evaluate(node => node.style.scale), "")
      await page.mouse.up()
      assert.equal(new URL(page.url()).hash, "#inline")
    }
    finally {
      await context.close()
    }
  })

  test("a press override registered before install wins until removed", async () => {
    const { context, page } = await open("?override")
    try {
      await pointerDown(page, "button")
      assert.equal(await page.locator("[data-test=button]").getAttribute("data-custom-press"), "true")
      await frames(page)
      assert.equal(await scaleOf(page, "button"), 1)
      await page.mouse.up()
      await page.evaluate(() => window.removePressOverride())
      assert.ok((await press(page, "button")).down < 0.99)
    }
    finally {
      await context.close()
    }
  })

  test("a pressed UButton squashes, springs back past rest, and clears its scale", async () => {
    const { context, errors, page } = await open()
    const trace = await sample(page, "button")
    await pointerDown(page, "button")
    // UButton sm is 28px high, so the spring settles at a 5% squash.
    await page.waitForFunction(() => window.pressTarget("button").style.scale === "0.95", undefined, { timeout: 15_000 })
    await page.mouse.up()
    await waitForRest(page, "button")
    await frames(page, 2)
    const { values } = await trace.stop()
    const low = Math.min(...values)
    assert.ok(low < 0.96 && low > 0.94, `the press squashes to about 0.95, not ${low}`)
    assert.ok(Math.max(...values) > 1.005, `the release passes rest, up to ${Math.max(...values)}`)
    assert.equal(values.at(-1), 1)
    assert.equal(await page.locator("[data-test=button]").evaluate(element => element.style.scale), "")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a second press during the spring-back continues from where the spring is, with no reset to rest", async () => {
    const { context, page } = await open()
    // At ¼× the spring-back lasts about 3s, so each press lands inside it however slow the machine is. Each press waits
    // for the state of the spring, not for a time.
    await page.locator("[data-test=speed]").click()
    await waitForRest(page, "speed")
    const trace = await sample(page, "button-outline")
    const latest = () => page.evaluate(() => window.sampled.at(-1))
    await pointerDown(page, "button-outline")
    await waitForScale(page, "button-outline", scale => scale < 0.97)
    await page.mouse.up()
    // The second press comes while the spring moves back toward rest.
    const bottom = await latest()
    await page.waitForFunction(low => window.sampled.at(-1) > low + 0.01 && window.sampled.at(-1) < 0.995, bottom, { timeout: 15_000 })
    await page.mouse.down()
    await waitForScale(page, "button-outline", scale => scale < 0.97)
    await page.mouse.up()
    // The third press comes while the spring passes rest.
    await waitForScale(page, "button-outline", scale => scale > 1.002)
    await page.mouse.down()
    await waitForScale(page, "button-outline", scale => scale < 0.97)
    await page.mouse.up()
    await waitForRest(page, "button-outline")
    await frames(page, 2)
    const { downs, inline, values } = await trace.stop()
    await context.close()

    assert.equal(downs.length, 3)
    for (const [index, down] of downs.slice(1).entries()) {
      // The spring was still moving when the press came, so this checks a press during the spring-back.
      assert.notEqual(down.scale, "", `press ${index + 2} came while the spring moved`)
      // The next frame goes on from the scale at the press, and does not start again from rest.
      const next = values[down.index]
      assert.ok(Math.abs(next - Number(down.scale)) < 0.01, `press ${index + 2}: ${down.scale} at the press, then ${next}`)
    }
    // A spring that went back to rest between the presses would have cleared its inline `scale`. The computed value can
    // read 1 where the spring passes rest, so the check reads the inline value.
    const first = inline.findIndex(value => value !== "")
    const last = inline.findLastIndex(value => value !== "")
    assert.ok(first >= 0 && first < downs[1].index && last >= downs[2].index, "the presses squash")
    assert.deepEqual(inline.slice(first, last + 1).filter(value => value === "").length, 0)
    // At ¼×, one frame moves at most 8ms of the spring, a small part of the 5% squash.
    const steps = values.slice(1).map((value, index) => Math.abs(value - values[index]))
    assert.ok(Math.max(...steps) < 0.015, `the largest step between two frames is ${Math.max(...steps)}`)
  })

  test("each Nuxt UI control and each role squashes", async () => {
    const { context, page } = await open()
    const ids = ["button-large", "button-link", ...roles.map(role => `role-${role}`), "plain-button", "plain-a", "plain-summary"]
    for (const id of ids) {
      const { down, settled } = await press(page, id)
      assert.ok(down < 0.99, `${id} squashes (${down})`)
      assert.equal(settled, 1, `${id} settles at rest`)
    }
    for (const selector of ["button[role=tab]", "button[role=checkbox]", "button[role=radio]"]) {
      const element = page.locator(selector).first()
      const box = await boxInView(element)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      const squashed = await element.evaluate(node => new Promise((resolve) => {
        let left = 120
        const check = () => getComputedStyle(node).scale !== "none" ? resolve(true) : --left ? requestAnimationFrame(check) : resolve(false)
        requestAnimationFrame(check)
      }))
      await page.mouse.up()
      assert.ok(squashed, `${selector} squashes`)
      await element.evaluate(node => new Promise((resolve) => {
        const check = () => node.style.scale ? requestAnimationFrame(check) : resolve()
        check()
      }))
    }
    await context.close()
  })

  test("an icon-only button squashes its icon by 15%", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "button-icon")
    await pointerDown(page, "button-icon")
    // The spring settles at a 15% squash of the icon.
    await page.waitForFunction(() => window.pressTarget("button-icon").style.scale === "0.85", undefined, { timeout: 15_000 })
    const { values } = await trace.stop()
    const icon = Math.min(...values)
    const own = await page.locator("[data-test=button-icon]").evaluate(element => getComputedStyle(element).scale)
    await page.mouse.up()
    assert.ok(icon <= 0.85 && icon > 0.83, `the icon squashes to about 0.85, not ${icon}`)
    assert.equal(own, "none")
    await context.close()
  })

  test("Space and Enter press the control that has focus", async () => {
    const { context, page } = await open()
    for (const key of ["Space", "Enter"]) {
      await page.locator("[data-test=plain-button]").focus()
      await page.keyboard.down(key)
      await waitForScale(page, "plain-button", scale => scale < 0.99)
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
      await frames(page)
      const down = await scaleOf(page, id)
      await page.mouse.up()
      assert.equal(down, 1, `${id} stays still`)
    }
    // A press on a span in a button squashes the button, not the span.
    await pointerDown(page, "inner-span")
    await waitForScale(page, "not-a-control-parent", scale => scale < 0.99)
    assert.equal(await page.locator("[data-test=inner-span]").evaluate(node => getComputedStyle(node).scale), "none")
    assert.ok(await scaleOf(page, "not-a-control-parent") < 0.99)
    await page.mouse.up()
    await context.close()
  })

  test("reduced motion turns the press off, from the system setting and from forceReducedMotion", async () => {
    const system = await open("", { reducedMotion: "reduce" })
    await pointerDown(system.page, "button")
    await frames(system.page)
    assert.equal(await scaleOf(system.page, "button"), 1)
    await system.page.mouse.up()
    // The layer follows a live change of the setting.
    await system.page.emulateMedia({ reducedMotion: "no-preference" })
    const { down } = await press(system.page, "button")
    assert.ok(down < 0.99, "the press comes back when reduced motion turns off")
    await system.context.close()

    const forced = await open()
    await pointerDown(forced.page, "button")
    await waitForScale(forced.page, "button", scale => scale < 0.99)
    assert.equal(await forced.page.evaluate(() => {
      window.forceReducedMotion(true)
      return window.pressTarget("button").style.scale
    }), "")
    await forced.page.mouse.up()
    await pointerDown(forced.page, "button")
    await frames(forced.page)
    assert.equal(await scaleOf(forced.page, "button"), 1)
    await forced.page.mouse.up()
    await forced.context.close()
  })

  test("a button in a shadow root gets the press", async () => {
    const { context, page } = await open()
    const button = page.locator("motion-shadow-button button")
    const box = await boxInView(button)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await waitForScale(page, "shadow", scale => scale < 0.99)
    const down = await button.evaluate(node => getComputedStyle(node).scale)
    await page.mouse.up()
    assert.ok(Number(down) < 0.99, `the shadow button squashes (${down})`)
    await context.close()
  })

  test("the ¼× speed makes the press four times slower", async () => {
    const { context, page } = await open()
    // Measures the time from the release to rest on the clock of the springs: each frame counts its time, up to 32ms,
    // so a slow frame on a busy machine does not count as motion that the spring never made.
    const timeToRest = async () => {
      await pointerDown(page, "button-outline")
      await page.waitForFunction(() => window.pressTarget("button-outline").style.scale === "0.95", undefined, { timeout: 15_000 })
      await page.evaluate(() => {
        window.restTime = new Promise((resolve) => {
          addEventListener("pointerup", () => {
            let total = 0
            let last = performance.now()
            const check = (time) => {
              total += Math.min(32, time - last)
              last = time
              if (window.pressTarget("button-outline").style.scale) requestAnimationFrame(check)
              else resolve(total)
            }
            requestAnimationFrame(check)
          }, { capture: true, once: true })
        })
      })
      await page.mouse.up()
      return page.evaluate(() => window.restTime)
    }
    const real = await timeToRest()
    await page.locator("[data-test=speed]").click()
    await waitForRest(page, "speed")
    const slow = await timeToRest()
    // The 1× press lasts about 30 frames, so one frame more or less at the start or the end moves the ratio by about 0.4.
    assert.ok(slow / real > 3.2 && slow / real < 4.8, `¼× takes ${Math.round(slow)}ms, 1× takes ${Math.round(real)}ms`)
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
