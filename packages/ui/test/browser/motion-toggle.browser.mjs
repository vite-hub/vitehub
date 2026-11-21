// The toggle effects of the motion layer in Chromium: the switch knob, the check that draws, and the pressed icon that
// wobbles like jelly. It runs the page `motion/` and reads each frame of the effect.
//
// Run: node --test test/browser/motion-toggle.browser.mjs
//
// Record mode: MOTION_RECORD=<dir> also records each toggle at ¼×, today and with the motion layer, and writes one
// video and one tiled image per subject. MOTION_PROTOTYPE=<file> adds the switch and the bookmark of the prototype.
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
  plugins: [vue(), nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme, icon: { clientBundle: { icons: ["lucide:bookmark"] } } })],
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
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2, ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/**
 * Calls `read(element)` on every frame until `stop()`, and returns what it gave. `read` runs in the page, so it can use
 * only its argument and the page's globals.
 */
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

/** The knob of a switch: where its center is from the left of the track, how it is drawn, and what the layer wrote. */
const knob = (element) => {
  const thumb = element.querySelector("[data-slot=thumb]") ?? element.firstElementChild
  const track = element.getBoundingClientRect()
  const box = thumb.getBoundingClientRect()
  return { x: box.left + box.width / 2 - track.left, width: box.width, height: box.height, written: thumb.style.translate || thumb.style.scale ? 1 : 0 }
}

/** The mark of a checkbox, in it or in the copy that draws out: its dash offset, and the opacity of what holds it. */
const mark = (element) => {
  const shape = element.querySelector("svg path")
  if (!shape) return { offset: null, length: 0, opacity: 1, paths: 0 }
  const holder = [...element.children].find(child => child.contains(shape))
  return {
    offset: shape.getAttribute("stroke-dashoffset") === null ? null : Number(shape.getAttribute("stroke-dashoffset")),
    length: shape.getTotalLength(),
    opacity: Number(getComputedStyle(holder).opacity),
    paths: element.querySelectorAll("svg path").length,
    ghost: element.querySelector("[aria-hidden=true]:not(svg)") ? 1 : 0,
  }
}

/** The path data of the one icon of a toggle button, or the `--svg` of an Iconify CSS icon. */
const outline = (element) => {
  const path = element.querySelector("svg path")
  if (path) return path.getAttribute("d")
  return element.querySelector(".iconify").style.getPropertyValue("--svg") || "class"
}

// The wobble of a knob settles about 1.6s after the change.
async function settle(page) {
  await page.waitForTimeout(2400)
}

describe("toggle: switch", async () => {
  test("the USwitch knob travels to the other side, stretches on the way, lands larger, and clears what it wrote", async () => {
    const { context, errors, page } = await open()
    const before = await page.locator("[data-test=switch-xl]").evaluate(knob)
    const trace = await sample(page, "[data-test=switch-xl]", knob)
    await page.locator("[data-test=switch-xl]").click()
    await settle(page)
    const frames = await trace.stop()
    const after = await page.locator("[data-test=switch-xl]").evaluate(knob)
    assert.equal(await page.locator("[data-test=switch-xl]").getAttribute("aria-checked"), "true")
    assert.ok(after.x - before.x > 15, `the knob travels from ${before.x} to ${after.x}`)
    assert.ok(after.width > before.width * 1.25, `the knob lands larger: ${before.width}px to ${after.width}px`)
    const aspect = Math.max(...frames.map(frame => frame.width / frame.height))
    assert.ok(aspect > 1.3, `mid-flight the knob is wider than high (${aspect.toFixed(2)})`)
    assert.ok(frames.some(frame => frame.written), "the layer moves the knob")
    assert.equal(after.written, 0, "the layer clears its translate and scale when the knob settles")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("the knob no longer has a CSS transition, and the switch track does not squash", async () => {
    const { context, page } = await open()
    const transition = await page.locator("[data-test=switch] [data-slot=thumb]").evaluate(thumb => getComputedStyle(thumb).transitionProperty)
    assert.doesNotMatch(transition, /transform|translate|scale|all/)
    await page.locator("[data-test=switch-xl]").scrollIntoViewIfNeeded()
    const box = await page.locator("[data-test=switch-xl]").boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await settle(page)
    const pressed = { track: await page.locator("[data-test=switch-xl]").evaluate(element => getComputedStyle(element).scale), ...await page.locator("[data-test=switch-xl]").evaluate(knob) }
    await page.mouse.up()
    assert.equal(pressed.track, "none", "the switch itself does not squash")
    assert.ok(pressed.width / pressed.height > 1.25, `a pressed knob grows into a pill (${(pressed.width / pressed.height).toFixed(2)})`)
    await settle(page)
    assert.equal((await page.locator("[data-test=switch-xl]").evaluate(knob)).written, 0)
    await context.close()
  })

  test("a fast double toggle continues from where the knob is, with no jump", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=switch-xl]", knob)
    // Both clicks come from the page, so a busy machine does not stretch the time between them.
    await page.locator("[data-test=switch-xl]").evaluate((element) => {
      element.click()
      setTimeout(() => element.click(), 90)
    })
    await settle(page)
    const frames = await trace.stop()
    const xs = frames.map(frame => frame.x)
    const steps = xs.slice(1).map((x, index) => Math.abs(x - xs[index]))
    // The travel is 20px. A knob that started again from a side would jump most of it in one frame.
    assert.ok(Math.max(...steps) < 6, `the largest step between two frames is ${Math.max(...steps).toFixed(2)}px`)
    assert.ok(Math.max(...xs) - xs[0] > 3 && Math.max(...xs) - xs[0] < 19, "the knob turns back before it reaches the other side")
    assert.ok(Math.abs(xs.at(-1) - xs[0]) < 0.5, "the knob is back where it started")
    await context.close()
  })

  test("Space toggles the switch with the same motion", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=switch-xl]").focus()
    const trace = await sample(page, "[data-test=switch-xl]", knob)
    await page.keyboard.press("Space")
    await settle(page)
    const frames = await trace.stop()
    assert.equal(await page.locator("[data-test=switch-xl]").getAttribute("aria-checked"), "true")
    assert.ok(Math.max(...frames.map(frame => frame.width / frame.height)) > 1.3, "the knob stretches")
    assert.ok(frames.at(-1).x - frames[0].x > 15)
    await context.close()
  })

  test("a plain role=switch with a knob of its own gets the same motion", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=plain-switch]", knob)
    await page.locator("[data-test=plain-switch]").click()
    await settle(page)
    const frames = await trace.stop()
    assert.ok(Math.max(...frames.map(frame => frame.width / frame.height)) > 1.3, "the knob stretches")
    assert.ok(Math.abs(frames.at(-1).x - frames[0].x - 16) < 0.5, "the knob ends 16px further, where its stylesheet puts it")
    assert.equal(frames.at(-1).written, 0)
    await context.close()
  })

  test("reduced motion moves the knob with no stretch, and data-motion=none turns the effect off", async () => {
    const { context, page } = await open("", { reducedMotion: "reduce" })
    const trace = await sample(page, "[data-test=switch-xl]", knob)
    await page.locator("[data-test=switch-xl]").click()
    await page.waitForTimeout(600)
    const frames = await trace.stop()
    assert.ok(frames.at(-1).x - frames[0].x > 15, "the knob is on the other side")
    assert.ok(frames.every(frame => Math.abs(frame.width / frame.height - 1) < 0.01), "the knob never stretches")
    assert.ok(frames.every(frame => !frame.written), "the layer writes nothing")
    await context.close()

    const off = await open()
    const offTrace = await sample(off.page, "[data-test=off-switch]", knob)
    await off.page.locator("[data-test=off-switch]").click()
    await off.page.waitForTimeout(600)
    const offFrames = await offTrace.stop()
    assert.ok(offFrames.at(-1).x - offFrames[0].x > 10, "the knob is on the other side")
    assert.ok(offFrames.every(frame => !frame.written), "the layer writes nothing inside data-motion=none")
    const steps = offFrames.slice(1).map((frame, index) => Math.abs(frame.x - offFrames[index].x))
    assert.equal(steps.filter(step => step > 0.01).length, 1, "the knob jumps in one frame")
    await off.context.close()
  })
})

describe("toggle: checkbox", async () => {
  test("clearing an initially mixed checkbox never animates a checkmark", async () => {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const { context, page } = await open("", { reducedMotion })
      const checkbox = page.locator("[data-test=checkbox-mixed]")
      assert.equal(await checkbox.getAttribute("aria-checked"), "mixed")
      const original = await checkbox.locator("svg path").getAttribute("d")
      const trace = await sample(page, "[data-test=checkbox-mixed]", element => element.querySelector("svg path")?.getAttribute("d") ?? null)
      await page.locator("[data-test=set-unchecked]").click()
      await settle(page)
      assert.equal(await checkbox.getAttribute("aria-checked"), "false")
      assert.ok((await trace.stop()).every(path => path === original || path === null))
      await context.close()
    }
  })

  test("the check draws in when it turns on and draws out when it turns off", async () => {
    const { context, errors, page } = await open()
    const on = await sample(page, "[data-test=checkbox]", mark)
    await page.locator("[data-test=checkbox]").click()
    await settle(page)
    const drawIn = (await on.stop()).filter(frame => frame.offset !== null)
    assert.ok(drawIn.length > 4, "the check draws over several frames")
    assert.ok(drawIn[0].offset > drawIn[0].length * 0.8, `the first frame hides most of the stroke (${drawIn[0].offset} of ${drawIn[0].length})`)
    assert.ok(drawIn.at(-1).offset < drawIn[0].length * 0.05, "the stroke is drawn")
    assert.equal(await page.locator("[data-test=checkbox] svg path").getAttribute("stroke-dashoffset"), null, "the layer puts the path back")

    const offTrace = await sample(page, "[data-test=checkbox]", mark)
    await page.locator("[data-test=checkbox]").click()
    await settle(page)
    const drawOut = await offTrace.stop()
    const drawing = drawOut.filter(frame => frame.offset !== null)
    assert.ok(drawing.length > 4 && drawing.every(frame => frame.ghost), "a copy of the check draws out in its place")
    assert.ok(drawing.at(-1).offset > drawing.at(-1).length * 0.8, "the stroke is gone at the end")
    assert.ok(drawing.at(-1).opacity < 0.2, "the box fades as the check goes")
    assert.equal(drawOut.at(-1).paths, 0, "the copy is removed")
    assert.equal(await page.locator("[data-test=checkbox]").getAttribute("aria-checked"), "false")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("the indeterminate minus and the check that follows it draw in", async () => {
    const { context, page } = await open()
    const trace = await sample(page, "[data-test=checkbox-mixed]", mark)
    await page.locator("[data-test=checkbox-mixed]").click()
    await settle(page)
    const toCheck = (await trace.stop()).filter(frame => frame.offset !== null)
    assert.ok(toCheck.length > 4 && toCheck[0].offset > toCheck[0].length * 0.8, "the check draws from the start")
    const minus = await sample(page, "[data-test=checkbox-mixed]", mark)
    await page.locator("[data-test=set-mixed]").click()
    await settle(page)
    const toMinus = (await minus.stop()).filter(frame => frame.offset !== null)
    assert.ok(toMinus.length > 4 && toMinus[0].offset > toMinus[0].length * 0.8, "the minus draws from the start")
    assert.equal(await page.locator("[data-test=checkbox-mixed]").getAttribute("aria-checked"), "mixed")
    await context.close()
  })

  test("Space toggles the checkbox with the same draw", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=checkbox]").focus()
    const trace = await sample(page, "[data-test=checkbox]", mark)
    await page.keyboard.press("Space")
    await settle(page)
    const frames = (await trace.stop()).filter(frame => frame.offset !== null)
    assert.ok(frames.length > 4 && frames[0].offset > frames[0].length * 0.8)
    await context.close()
  })

  test("reduced motion shows the check with a crossfade, and data-motion=none turns the effect off", async () => {
    const { context, page } = await open("", { reducedMotion: "reduce" })
    const trace = await sample(page, "[data-test=checkbox]", mark)
    await page.locator("[data-test=checkbox]").click()
    await page.waitForTimeout(600)
    const frames = await trace.stop()
    assert.ok(frames.every(frame => frame.offset === null), "the stroke does not draw")
    assert.ok(frames.some(frame => frame.paths && frame.opacity > 0 && frame.opacity < 1), "the check fades in")
    assert.equal(frames.at(-1).opacity, 1)
    await context.close()

    const off = await open()
    const offTrace = await sample(off.page, "[data-test=off-checkbox]", mark)
    await off.page.locator("[data-test=off-checkbox]").click()
    await off.page.waitForTimeout(600)
    const offFrames = await offTrace.stop()
    assert.ok(offFrames.every(frame => frame.offset === null && frame.opacity === 1), "the check shows at once")
    await off.context.close()
  })
})

describe("toggle: pressed icon", async () => {
  test("jelly restores Nuxt UI's inline CSS mask and leaves an open stroke alone", async () => {
    const { context, page } = await open()
    const button = page.locator("[data-test=inline-mask]")
    const icon = button.locator(".iconify")
    await page.waitForFunction(() => document.querySelector("[data-test=inline-mask] .iconify")?.style.getPropertyValue("--svg"))
    const original = await icon.evaluate(element => getComputedStyle(element).maskImage)
    assert.match(original, /^url\(/)
    await icon.evaluate(element => element.style.setProperty("--svg", element.style.getPropertyValue("--svg"), "important"))
    const originalValue = await icon.evaluate(element => element.style.getPropertyValue("--svg"))
    const trace = await sample(page, "[data-test=inline-mask]", outline)
    await button.click()
    await settle(page)
    assert.ok((await trace.stop()).some(value => value !== originalValue && value !== "class"), "the inline mask deforms")
    assert.equal(await icon.evaluate(element => getComputedStyle(element).maskImage), original)
    assert.equal(await icon.evaluate(element => element.style.getPropertyValue("--svg")), originalValue)
    assert.equal(await icon.evaluate(element => element.style.getPropertyPriority("--svg")), "important")

    await button.click()
    await page.waitForFunction(original => {
      const value = document.querySelector("[data-test=inline-mask] .iconify")?.style.getPropertyValue("--svg")
      return value && value !== original
    }, originalValue)
    await icon.evaluate(element => element.style.setProperty("--svg", "none"))
    const changed = await sample(page, "[data-test=inline-mask]", outline)
    await settle(page)
    assert.ok((await changed.stop()).every(value => value === "none"), "motion does not reclaim a mask changed by the component")

    const bold = await page.locator("[data-test=bold]").evaluate(outline)
    const boldTrace = await sample(page, "[data-test=bold]", outline)
    await page.locator("[data-test=bold]").click()
    await settle(page)
    assert.ok((await boldTrace.stop()).every(value => value === bold), "the open path is never deformed")
    await context.close()
  })

  test("a pressed bookmark wobbles like jelly and gets its exact path data back", async () => {
    const { context, errors, page } = await open()
    const original = await page.locator("[data-test=bookmark]").evaluate(outline)
    const trace = await sample(page, "[data-test=bookmark]", outline)
    await page.locator("[data-test=bookmark]").click()
    await settle(page)
    const frames = await trace.stop()
    const changed = frames.filter(d => d !== original)
    assert.ok(changed.length > 10, `the path changes on ${changed.length} frames`)
    assert.ok(new Set(changed).size > 10, "the shape moves from frame to frame")
    assert.equal(frames.at(-1), original, "the path data is byte-equal to the original after the wave")
    assert.equal(await page.locator("[data-test=bookmark]").getAttribute("aria-pressed"), "true")
    // Turning it off plays the wave again.
    const back = await sample(page, "[data-test=bookmark]", outline)
    await page.locator("[data-test=bookmark]").click()
    await settle(page)
    const backFrames = await back.stop()
    assert.ok(backFrames.filter(d => d !== original).length > 10)
    assert.equal(backFrames.at(-1), original)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a star with a label wobbles, and an Iconify CSS icon wobbles through its mask", async () => {
    const { context, page } = await open()
    const star = await page.locator("[data-test=star]").evaluate(outline)
    const starTrace = await sample(page, "[data-test=star]", outline)
    await page.locator("[data-test=star]").click()
    await settle(page)
    const starFrames = await starTrace.stop()
    assert.ok(starFrames.filter(d => d !== star).length > 10)
    assert.equal(starFrames.at(-1), star)

    await page.evaluate(() => {
      window.measuredAttributes = []
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof SVGSVGElement) {
              window.measuredAttributes.push([...node.children].map(child => child.getAttributeNames()))
            }
          }
        }
      }).observe(document.body, { childList: true })
    })
    const cssTrace = await sample(page, "[data-test=css-bookmark]", outline)
    await page.locator("[data-test=css-bookmark]").click()
    await settle(page)
    const cssFrames = await cssTrace.stop()
    assert.ok(new Set(cssFrames.filter(value => value !== "class")).size > 10, "the mask changes on each frame")
    assert.equal(cssFrames.at(-1), "class", "the layer removes its --svg")
    assert.deepEqual(await page.evaluate(() => window.measuredAttributes), [[["d"]]], "only fresh path geometry enters the page")
    await context.close()
  })

  test("Space toggles the bookmark with the same wave", async () => {
    const { context, page } = await open()
    const original = await page.locator("[data-test=bookmark]").evaluate(outline)
    await page.locator("[data-test=bookmark]").focus()
    const trace = await sample(page, "[data-test=bookmark]", outline)
    await page.keyboard.press("Space")
    await settle(page)
    const frames = await trace.stop()
    assert.ok(frames.filter(d => d !== original).length > 10)
    assert.equal(frames.at(-1), original)
    await context.close()
  })

  test("an icon of two paths, a segmented control, reduced motion, and data-motion=none get no jelly", async () => {
    const still = async (page, id, click = id) => {
      const original = await page.locator(`[data-test=${id}]`).evaluate(outline)
      const trace = await sample(page, `[data-test=${id}]`, outline)
      await page.locator(`[data-test=${click}]`).click()
      await page.waitForTimeout(900)
      const frames = await trace.stop()
      assert.ok(frames.every(d => d === original), `${id} keeps its path`)
    }
    const { context, page } = await open()
    await still(page, "pin")
    await still(page, "view-list")
    await still(page, "view-grid", "view-list")
    await still(page, "off-bookmark")
    await context.close()

    const reduced = await open("", { reducedMotion: "reduce" })
    await still(reduced.page, "bookmark")
    await reduced.context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each toggle at ¼×", { timeout: 600_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const subjects = [
      { name: "switch-today", query: "?mode=today", selector: "[data-test=switch-xl]", cssRate: true },
      { name: "switch-spring", query: "", selector: "[data-test=switch-xl]" },
      { name: "checkbox-today", query: "?mode=today", selector: "[data-test=checkbox]", cssRate: true },
      { name: "checkbox-spring", query: "", selector: "[data-test=checkbox]" },
      { name: "bookmark-today", scale: 6, query: "?mode=today", selector: "[data-test=bookmark]", cssRate: true },
      { name: "bookmark-spring", scale: 6, query: "", selector: "[data-test=bookmark]" },
    ]
    if (process.env.MOTION_PROTOTYPE) {
      const url = pathToFileURL(process.env.MOTION_PROTOTYPE).href
      subjects.push(
        { name: "prototype-switch", url, selector: "#v-switch-a", prototype: "tactile" },
        { name: "prototype-bookmark", url, selector: "#v-save-btn", prototype: "tactile" },
      )
    }
    // MOTION_SUBJECTS=<name,name> records only those.
    const only = process.env.MOTION_SUBJECTS?.split(",")
    if (only) subjects.splice(0, subjects.length, ...subjects.filter(subject => only.includes(subject.name)))
    const warm = await open()
    await warm.context.close()
    for (const subject of subjects) await record(subject)
  })
}

/**
 * Toggles the element on, then off, and records it at ¼×: each press holds 120ms of motion time. It writes a video and
 * a tiled image of the toggle on.
 */
async function record({ name, query, url, selector, cssRate, prototype, scale = 2 }) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } })
  const page = await context.newPage()
  if (url) await page.goto(url)
  else {
    await page.goto(`${base}${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  }
  // The page draws at twice its size, or more for a 16px icon, so the small controls show their detail. The layout
  // stays as it is.
  await page.addStyleTag({ content: `body { transform: scale(${scale}); transform-origin: 0 0 }` })
  // A headless browser draws no pointer, so the page draws one that follows the mouse, outside the scaled body.
  await page.evaluate(() => {
    const arrow = encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'><path d='M1 1v16l4-4 3 6 2-1-3-6h6z' fill='black' stroke='white' stroke-width='1.2' stroke-linejoin='round'/></svg>")
    const tip = document.createElement("div")
    tip.style.cssText = `position:fixed;left:0;top:0;z-index:99;width:21px;height:30px;pointer-events:none;background:url("data:image/svg+xml,${arrow}")`
    document.documentElement.append(tip)
    addEventListener("mousemove", event => (tip.style.translate = `${event.clientX}px ${event.clientY}px`))
  })
  const element = page.locator(selector)
  if (prototype) {
    await element.evaluate((node, mode) => {
      const section = node.closest("section")
      section.querySelector(`[data-k=mode] [data-v=${mode}]`).click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    }, prototype)
  }
  else if (cssRate) {
    const cdp = await context.newCDPSession(page)
    await cdp.send("Animation.enable")
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.25 })
  }
  else await page.locator("[data-test=speed]").click()
  // The speed button is at the top, so scroll to the element after it.
  await element.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)

  // The clip holds the control and the label beside it.
  const box = await element.evaluate((node) => {
    const holder = node.closest("[data-slot=root], .swrow, .saverow") ?? node
    const rect = holder.getBoundingClientRect()
    const own = node.getBoundingClientRect()
    // The pointer presses near the lower end corner, so it does not hide the knob, the check, or the icon.
    return { x: Math.min(rect.x, own.x), y: Math.min(rect.y, own.y), width: Math.max(rect.right, own.right) - Math.min(rect.x, own.x), height: Math.max(rect.bottom, own.bottom) - Math.min(rect.y, own.y), cx: own.right - own.width * 0.2, cy: own.bottom - own.height * 0.2 }
  })
  const pad = 16 * scale / 2
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
  await page.mouse.move(box.cx, box.cy, { steps: 8 })
  await page.waitForTimeout(600)
  const startAt = Date.now() / 1000
  for (let index = 0; index < 2; index++) {
    await page.mouse.down()
    await page.waitForTimeout(480)
    await page.mouse.up()
    await page.waitForTimeout(3200)
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
  const lead = Math.max(0, startAt - frames[0].at)
  ffmpeg("-f", "concat", "-i", join(dir, "frames.txt"), "-vf", `${crop},scale=-2:'min(ih,240)',pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", "-an", join(recordDir, `${name}.mp4`))
  // The tiled image: 32 frames at even times over the toggle on, from the press to the rest, 8 per row.
  ffmpeg("-ss", String(lead.toFixed(2)), "-i", join(recordDir, `${name}.mp4`), "-vf", "fps=32/3.6,tile=8x4:padding=4:color=white", "-frames:v", "1", join(recordDir, `${name}.png`))
}
