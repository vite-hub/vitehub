// Drag a value in Chromium: the slider effect and the divider effect of `@vite-hub/ui/motion` on the motion page.
// Run: pnpm --filter @vite-hub/ui test:motion
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
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1, ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/** The box of an element after it is scrolled into view, so the mouse can reach it on a page that grows with each unit. */
async function boxInView(locator) {
  await locator.scrollIntoViewIfNeeded()
  return locator.boundingBox()
}

const sliders = [
  { name: "USlider", root: "[data-test=slider]", track: "[data-test=slider] [data-slot=track]", value: "[data-test=slider] [role=slider]", thumb: "[data-test=slider] [role=slider]" },
  { name: "ui-sdk slider", root: "[data-test=sdk-slider]", track: "[data-test=sdk-slider] [data-slot=slider-track]", value: "[data-test=sdk-slider] input[type=range]", thumb: "[data-test=sdk-slider] [data-slot=slider-thumb]" },
  { name: "plain slider", root: "[data-test=plain-slider]", track: "[data-test=plain-slider]", value: "[data-test=plain-slider] [role=slider]", thumb: "[data-test=plain-slider] [role=slider]" },
]

/**
 * Records on every frame, until `stop()`: the thumb's computed `scale` on the travel axis and across it, and the box of
 * the tail and of the track along x.
 */
async function sampleSlider(page, slider) {
  await page.evaluate(({ thumb, track, root }) => {
    const thumbElement = document.querySelector(thumb)
    const trackElement = document.querySelector(track)
    const rootElement = document.querySelector(root)
    const frames = []
    let running = true
    const read = () => {
      const scale = getComputedStyle(thumbElement).scale
      const [x, y = x] = scale === "none" ? [1, 1] : scale.split(" ").map(Number)
      const path = rootElement.querySelector("svg[data-motion=tail] path")
      const tail = path && path.getAttribute("d") ? path.getBoundingClientRect() : null
      const box = trackElement.getBoundingClientRect()
      frames.push({ x, y, tail: tail && { left: tail.left, right: tail.right, width: tail.width }, track: { left: box.left, right: box.right } })
      if (running) requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.stopSlider = () => {
      running = false
      return frames
    }
  }, slider)
  return { stop: () => page.evaluate(() => window.stopSlider()) }
}

/** Drags from 20% to 85% of the track in a few big steps, a fast flick, holds, then lets go. */
async function flick(page, slider, { hold = 400 } = {}) {
  const box = await boxInView(page.locator(slider.track))
  const y = box.y + box.height / 2
  const thumb = await page.locator(slider.thumb).boundingBox()
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 2 })
  await page.waitForTimeout(250)
  for (const fraction of [0.4, 0.6, 0.85]) {
    await page.mouse.move(box.x + box.width * fraction, y)
    await page.waitForTimeout(16)
  }
  await page.waitForTimeout(hold)
  await page.mouse.up()
}

async function settled(page, slider) {
  await page.waitForFunction(({ thumb, root }) => {
    const element = document.querySelector(thumb)
    return !element.style.scale && !document.querySelector(root).querySelector("svg[data-motion=tail]")
  }, slider, { timeout: 5000 })
}

describe("slider", () => {
  for (const slider of sliders) {
    test(`${slider.name}: the thumb stretches with its speed, a tail trails it inside the track, and it is round again after it stops`, async () => {
      const { context, errors, page } = await open()
      const trace = await sampleSlider(page, slider)
      await flick(page, slider)
      await settled(page, slider)
      const frames = await trace.stop()
      const stretched = frames.filter(frame => frame.x > frame.y + 0.02)
      assert.ok(stretched.length, `the thumb stretches along the track at speed, up to ${Math.max(...frames.map(frame => frame.x / frame.y))}`)
      assert.ok(Math.max(...frames.map(frame => frame.x)) > 1.12, "the scale on the travel axis passes the held 1.12")
      const tails = frames.filter(frame => frame.tail && frame.tail.width > 2)
      assert.ok(tails.length, "a tail trails the thumb")
      for (const { tail, track } of tails) {
        assert.ok(tail.left >= track.left - 1 && tail.right <= track.right + 1, `the tail ${tail.left}..${tail.right} stays in the track ${track.left}..${track.right}`)
      }
      // While it is held after the flick it is round and 12% larger, and once let go it is round at rest.
      const last = frames.at(-1)
      assert.equal(last.x, 1)
      assert.equal(last.y, 1)
      assert.equal(last.tail, null)
      assert.deepEqual(errors, [])
      await context.close()
    })
  }

  test("a flick toward the start keeps the tail inside the track too", async () => {
    const { context, page } = await open()
    const slider = sliders[0]
    const box = await boxInView(page.locator(slider.track))
    const y = box.y + box.height / 2
    const trace = await sampleSlider(page, slider)
    await page.mouse.move(box.x + box.width * 0.9, y)
    await page.mouse.down()
    await page.waitForTimeout(250)
    await page.mouse.move(box.x + 2, y)
    await page.waitForTimeout(400)
    await page.mouse.up()
    await settled(page, slider)
    const frames = await trace.stop()
    const tails = frames.filter(frame => frame.tail && frame.tail.width > 2)
    assert.ok(tails.length, "a tail trails the thumb")
    for (const { tail, track } of tails) assert.ok(tail.left >= track.left - 1 && tail.right <= track.right + 1, `the tail ${tail.left}..${tail.right} stays in ${track.left}..${track.right}`)
    await context.close()
  })

  test("an arrow key steps the value and nudges the thumb there", async () => {
    const { context, page } = await open()
    for (const slider of sliders) {
      const value = page.locator(slider.value)
      const read = () => value.evaluate(node => Number(node.getAttribute("aria-valuenow") ?? node.value))
      const before = await read()
      await value.focus()
      const trace = await sampleSlider(page, slider)
      const start = await page.locator(slider.thumb).evaluate(node => node.getBoundingClientRect().left)
      await page.keyboard.press("Shift+ArrowRight")
      // The next frame still shows the thumb near where it was.
      const next = await page.locator(slider.thumb).evaluate(node => new Promise(resolve => requestAnimationFrame(() => resolve(node.getBoundingClientRect().left))))
      await settled(page, slider)
      await trace.stop()
      const after = await read()
      const end = await page.locator(slider.thumb).evaluate(node => node.getBoundingClientRect().left)
      assert.equal(after, before + 10, `${slider.name} steps by 10`)
      assert.ok(end - start > 20, `${slider.name} moves to its new value (${start} → ${end})`)
      assert.ok(next - start < (end - start) * 0.9, `${slider.name} springs there and does not jump (${start} → ${next} → ${end})`)
    }
    await context.close()
  })
})

/** The drawn bend of a divider: how far its middle point leaves the straight line, or 0 when there is none. */
function bendOf(page) {
  return page.evaluate(() => {
    const path = document.querySelector("svg[data-motion=bend] path")
    if (!path) return 0
    const numbers = path.getAttribute("d").match(/-?[\d.]+/g).map(Number)
    // M x,y C c1 c2 tip C ...: the start x and the tip x.
    return Math.abs(numbers[6] - numbers[0])
  })
}

test("an inverted thumb approaches the midpoint from its previous side", async () => {
  const { context, page } = await open("?inverted")
  const thumb = page.locator(sliders[0].thumb)
  await thumb.focus()
  const first = await thumb.evaluate(node => {
    const start = node.getBoundingClientRect().left
    return new Promise(resolve => {
      new MutationObserver((_, observer) => {
        observer.disconnect()
        requestAnimationFrame(() => resolve({ start, next: node.getBoundingClientRect().left }))
      }).observe(node, { attributeFilter: ["aria-valuenow"] })
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }))
    })
  })
  assert.equal(await thumb.getAttribute("aria-valuenow"), "50")
  await settled(page, sliders[0])
  const end = await thumb.evaluate(node => node.getBoundingClientRect().left)
  assert.ok(first.next > end + 5 && first.next <= first.start + 1, `${first.start} → ${first.next} → ${end}`)
  await context.close()
})

test("fill follows visible thumb endpoints at zero and on simultaneous updates", async () => {
  const { context, page } = await open("?inverted")
  for (const slider of sliders.slice(0, 2)) {
    const frame = await page.locator(slider.value).evaluate((node, { root, thumb }) => {
      node.focus()
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
      // A native range's default action is not run for a synthetic key.
      if (node instanceof HTMLInputElement) {
        node.value = "0"
        node.dispatchEvent(new Event("input", { bubbles: true }))
      }
      return new Promise(resolve => requestAnimationFrame(() => {
        const fill = document.querySelector(root).querySelector("[data-slot=range], [data-slot=slider-indicator]").getBoundingClientRect()
        const box = document.querySelector(thumb).getBoundingClientRect()
        resolve({ width: fill.width, error: Math.min(Math.abs(fill.left - box.x - box.width / 2), Math.abs(fill.right - box.x - box.width / 2)) })
      }))
    }, slider)
    assert.ok(frame.width > 30 && frame.error < 2, `${slider.name}: ${JSON.stringify(frame)}`)
  }
  const errors = await page.evaluate(() => {
    document.querySelector("[data-test=set-interval]").click()
    return new Promise(resolve => requestAnimationFrame(() => {
      const root = document.querySelector("[data-test=interval]")
      const fill = root.querySelector("[data-slot=range]").getBoundingClientRect()
      const centers = [...root.querySelectorAll("[role=slider]")].map(node => {
        const box = node.getBoundingClientRect()
        return box.x + box.width / 2
      })
      resolve([Math.abs(fill.left - centers[0]), Math.abs(fill.right - centers[1])])
    }))
  })
  assert.ok(errors.every(error => error < 2), `fill endpoint errors: ${errors}`)
  await context.close()
})

test("track discovery ignores sibling controls, opted-out thumbs, and native ranges", async () => {
  const { context, page } = await open()
  const scales = await page.evaluate(() => {
    const root = document.querySelector("[data-test=slider]")
    const thumb = root.querySelector("[role=slider]")
    thumb.dataset.motion = "none"
    const button = root.appendChild(document.createElement("button"))
    const label = document.body.appendChild(document.createElement("label"))
    label.innerHTML = '<input type="range" style="position:absolute">'
    const press = (target, observed, pointerId) => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId }))
      const scale = observed.style.scale
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId }))
      return scale
    }
    return [press(button, thumb, 1), press(root.querySelector("[data-slot=track]"), thumb, 2), press(label.firstElementChild, label, 3)]
  })
  assert.deepEqual(scales, ["", "", ""])
  await context.close()
})

test("USplitter bends when Reka starts a drag outside the handle", async () => {
  const { context, page } = await open()
  const handle = page.locator("[data-test=splitter] [role=separator]")
  const box = await boxInView(handle)
  const x = box.x - 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  assert.equal(await handle.getAttribute("data-resize-handle-active"), "pointer")
  await page.mouse.move(x + 150, y, { steps: 10 })
  await page.waitForTimeout(100)
  assert.ok(await bendOf(page) > 20)
  await page.mouse.up()
  await context.close()
})

test("live reduced motion clears held drag visuals without stopping the drag", async () => {
  const { context, page } = await open()
  const thumb = page.locator(sliders[0].thumb)
  const box = await boxInView(thumb)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  assert.notEqual(await thumb.evaluate(node => node.style.scale), "")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForFunction(selector => !document.querySelector(selector).style.scale, sliders[0].thumb, { timeout: 1000 })
  await page.mouse.move(x + 50, y)
  assert.ok(Number(await thumb.getAttribute("aria-valuenow")) > 40)
  assert.equal(await thumb.evaluate(node => node.style.scale), "")
  await page.mouse.up()

  await page.emulateMedia({ reducedMotion: "no-preference" })
  const handle = await boxInView(page.locator("[data-test=resize]"))
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 150, handle.y + handle.height / 2, { steps: 10 })
  await page.waitForSelector("svg[data-motion=bend]")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForSelector("svg[data-motion=bend]", { state: "detached", timeout: 1000 })
  await page.mouse.move(handle.x + 40, handle.y + handle.height / 2)
  assert.equal(await bendOf(page), 0)
  assert.ok((await page.locator("[data-test=files]").boundingBox()).width < 220)
  await page.mouse.up()
  await context.close()
})

describe("divider", () => {
  const handles = [
    // The Files panel of the USplitter has a maxSize of 40%, and the panels share the group less the 8px handle.
    { name: "USplitter", handle: "[data-test=splitter] [role=separator]", panel: "[data-test=splitter] [data-panel-id=files]", max: page => page.locator("[data-test=splitter]").evaluate(node => (node.clientWidth - 8) * 0.4) },
    { name: "plain resize handle", handle: "[data-test=resize]", panel: "[data-test=files]", max: () => 220 },
  ]
  for (const subject of handles) {
    test(`${subject.name}: a drag past the limit bends the divider, the panel stays at its limit, and it springs back straight`, async () => {
      const { context, errors, page } = await open()
      const box = await boxInView(page.locator(subject.handle))
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 150, y + 20, { steps: 10 })
      await page.waitForTimeout(100)
      const bend = await bendOf(page)
      const width = await page.locator(subject.panel).evaluate(node => node.getBoundingClientRect().width)
      const handleNow = await page.locator(subject.handle).boundingBox()
      assert.ok(bend > 20, `the divider bends toward the pointer (${bend}px)`)
      assert.ok(bend < 60, `the bend stays under 60px (${bend}px)`)
      const max = await subject.max(page)
      assert.ok(Math.abs(width - max) <= 1, `the panel stays at its limit (${width}px, the limit is ${max}px)`)
      assert.ok(handleNow.x + handleNow.width / 2 < x + 150 - 40, "the divider stays at the limit, not under the pointer")
      assert.equal(await page.locator(subject.handle).evaluate(node => getComputedStyle(node).scale), "none", "the divider itself does not scale")
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector("svg[data-motion=bend]"), undefined, { timeout: 5000 })
      assert.equal(await page.locator(subject.handle).evaluate(node => node.style.opacity), "", "its own line shows again")
      assert.deepEqual(errors, [])
      await context.close()
    })
  }

  test("within its limits the handle stays under the pointer on every frame, with no bend", async () => {
    const { context, page } = await open()
    for (const subject of handles) {
      const box = await boxInView(page.locator(subject.handle))
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.evaluate((selector) => {
        const handle = document.querySelector(selector)
        const frames = []
        let pointer
        let running = true
        const onMove = event => (pointer = event.clientX)
        document.addEventListener("pointermove", onMove, true)
        const read = () => {
          const rect = handle.getBoundingClientRect()
          if (pointer !== undefined) frames.push({ pointer, center: rect.left + rect.width / 2, bend: !!document.querySelector("svg[data-motion=bend] path[d]") && document.querySelector("svg[data-motion=bend] path").getAttribute("d") })
          if (running) requestAnimationFrame(read)
        }
        requestAnimationFrame(read)
        window.stopHandle = () => {
          running = false
          document.removeEventListener("pointermove", onMove, true)
          return frames
        }
      }, subject.handle)
      await page.mouse.move(x, y)
      await page.mouse.down()
      // 8 moves of 3px stay inside the limits of both: 150px to 126px, and 30% to 25.6%.
      for (let step = 1; step <= 8; step++) {
        await page.mouse.move(x - step * 3, y)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await page.waitForTimeout(100)
      const frames = await page.evaluate(() => window.stopHandle())
      // A frame shows the pointer's last move once the component and the effect have run, so compare from the frame after it.
      const lag = frames.slice(1).map(frame => Math.abs(frame.center - frame.pointer))
      assert.ok(frames.length > 6, "frames were recorded")
      assert.ok(Math.max(...lag) <= 1.5, `${subject.name} stays under the pointer, at most ${Math.max(...lag)}px away`)
      assert.ok(!(await page.locator("svg[data-motion=bend]").count()), `${subject.name} does not bend within its limits`)
    }
    await context.close()
  })
})

describe("drag motion off", () => {
  async function noMotion(page) {
    const slider = sliders[0]
    const trace = await sampleSlider(page, slider)
    await flick(page, slider, { hold: 100 })
    const frames = await trace.stop()
    assert.ok(frames.every(frame => frame.x === 1 && frame.y === 1), "the thumb does not stretch or grow")
    assert.ok(frames.every(frame => frame.tail === null), "there is no tail")
    const box = await boxInView(page.locator("[data-test=resize]"))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 10 })
    await page.waitForTimeout(100)
    assert.equal(await bendOf(page), 0, "the divider does not bend")
    await page.mouse.up()
  }

  test("reduced motion: no stretch, no tail, no bend", async () => {
    const { context, page } = await open("", { reducedMotion: "reduce" })
    await noMotion(page)
    // The value still changes.
    assert.notEqual(await page.locator(sliders[0].value).getAttribute("aria-valuenow"), "40")
    await context.close()
  })

  test("data-motion=none turns the slider and the divider off", async () => {
    const { context, page } = await open()
    await page.evaluate(() => {
      for (const selector of ["[data-test=slider]", "[data-test=panels]"]) document.querySelector(selector).closest("section").dataset.motion = "none"
    })
    await noMotion(page)
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each drag at ¼×", { timeout: 600_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const subjects = [
      { name: "slider-spring", gesture: "flick", query: "", target: "[data-test=plain-slider]" },
      { name: "slider-today", gesture: "flick", query: "?mode=today", target: "[data-test=plain-slider]" },
      { name: "uslider-spring", gesture: "flick", query: "", target: "[data-test=slider]" },
      { name: "uslider-today", gesture: "flick", query: "?mode=today", target: "[data-test=slider]" },
      { name: "divider-spring", gesture: "pull", query: "", target: "[data-test=panels]", handle: "[data-test=resize]" },
      { name: "divider-today", gesture: "pull", query: "?mode=today", target: "[data-test=panels]", handle: "[data-test=resize]" },
      { name: "usplitter-spring", gesture: "pull", query: "", target: ".splitter-frame", handle: "[data-test=splitter] [role=separator]" },
      { name: "usplitter-today", gesture: "pull", query: "?mode=today", target: ".splitter-frame", handle: "[data-test=splitter] [role=separator]" },
    ]
    if (process.env.MOTION_PROTOTYPE) {
      const url = pathToFileURL(process.env.MOTION_PROTOTYPE).href
      subjects.push(
        { name: "prototype-slider", gesture: "flick", url, target: "#v-slider-track", prototype: "tactile" },
        { name: "prototype-divider", gesture: "pull", url, target: "#v-panels-split", handle: "#v-panels-e0", prototype: "tactile" },
      )
    }
    const warm = await open()
    await warm.context.close()
    for (const subject of subjects) await record(subject)
  })
}

/**
 * Plays one gesture at ¼× and records each frame that Chromium paints: a flick from 20% to 85% of a slider, or a pull of
 * a divider 150px to the right, past its limit, then a release. Writes `<name>.mp4` and a tiled `<name>.png`.
 */
async function record({ name, gesture, query, url, target, handle, prototype }) {
  const context = await browser.newContext({ viewport: { width: 800, height: 1600 } })
  const page = await context.newPage()
  if (url) await page.goto(url)
  else {
    await page.goto(`${base}${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  }
  const element = page.locator(target)
  await element.scrollIntoViewIfNeeded()
  // A headless browser draws no pointer, so draw an arrow whose tip follows the mouse.
  await page.evaluate(() => {
    const tip = document.body.appendChild(document.createElement("div"))
    tip.innerHTML = "<svg viewBox=\"0 0 14 20\" width=\"14\" height=\"20\"><path d=\"M1 1v16l4-4 3 6 2-1-3-6h6z\" fill=\"#111\" stroke=\"#fff\" stroke-width=\"1.2\" stroke-linejoin=\"round\"/></svg>"
    tip.style.cssText = "position:fixed;left:0;top:0;z-index:99;pointer-events:none;line-height:0"
    addEventListener("mousemove", event => (tip.style.translate = `${event.clientX}px ${event.clientY}px`), true)
  })
  if (prototype) {
    await element.evaluate((node, mode) => {
      const section = node.closest("section")
      section.querySelector(`[data-k=mode] [data-v=${mode}]`).click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    }, prototype)
  }
  else if (!query) await page.evaluate(() => document.querySelector("[data-test=speed]").click())
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)
  const box = await element.boundingBox()
  // A flick keeps room above the track for the prototype's value bubble.
  const pad = gesture === "flick" ? 16 : 8
  const above = gesture === "flick" && prototype ? 40 : 0
  const clip = { x: Math.floor(box.x - pad), y: Math.floor(box.y - pad - above), width: Math.ceil(box.width + 2 * pad), height: Math.ceil(box.height + 2 * pad + above) }
  const dir = join(recordDir, name)
  mkdirSync(dir, { recursive: true })
  const cdp = await context.newCDPSession(page)
  const frames = []
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, at: metadata.timestamp })
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
  })
  const viewport = page.viewportSize()
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: viewport.width, maxHeight: viewport.height })
  if (gesture === "flick") {
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * 0.2, y)
    await page.waitForTimeout(500)
    await page.mouse.down()
    await page.waitForTimeout(600)
    for (const fraction of [0.4, 0.6, 0.85]) {
      await page.mouse.move(box.x + box.width * fraction, y)
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(2000)
    await page.mouse.up()
    await page.waitForTimeout(2000)
  }
  else {
    const edge = await page.locator(handle).boundingBox()
    const x = edge.x + edge.width / 2
    const y = edge.y + edge.height / 2
    await page.mouse.move(x, y)
    await page.waitForTimeout(500)
    await page.mouse.down()
    await page.mouse.move(x + 150, y + 20, { steps: 20 })
    await page.waitForTimeout(800)
    await page.mouse.up()
    await page.waitForTimeout(3000)
  }
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
  ffmpeg("-f", "concat", "-i", join(dir, "frames.txt"), "-vf", `${crop},scale=iw*2:ih*2:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-an", join(recordDir, `${name}.mp4`))
  // The tiled image: 24 frames from the press to the rest, 4 per row.
  ffmpeg("-ss", "0.4", "-i", join(recordDir, `${name}.mp4`), "-vf", `fps=24/${gesture === "flick" ? 4.6 : 4.2},tile=4x6:padding=4:color=white`, "-frames:v", "1", join(recordDir, `${name}.png`))
}
