// The effects that wave 5 added to `@vite-hub/ui/motion`, in Chromium: the disclosure chevron, a mark that leaves, an
// element that appears next to its trigger, a press that squashes the element that draws the control, and the shake
// helper. It runs the page `motion/w5.html` and reads each effect frame by frame.
//
// Run: node --test test/browser/motion-w5.browser.mjs (or pnpm --filter @vite-hub/ui test:motion)
import assert from "node:assert/strict"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { build, createServer } from "vite"

const root = fileURLToPath(new URL("./motion/", import.meta.url))
// Only this page: the other pages of the folder need the Vue and Nuxt UI plugins.
const server = await createServer({ configFile: false, logLevel: "warn", optimizeDeps: { entries: ["w5.html"] }, root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open() {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${base}w5.html`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

/** Runs `action` in the page and reads `read` on each frame after it, for `frames` frames. Both are page functions. */
async function frames(page, action, read, count = 60) {
  return page.evaluate(async ({ action, read, count }) => {
    const run = new Function(`return (${action})()`)
    const sample = new Function(`return (${read})()`)
    const out = []
    run()
    for (let index = 0; index < count; index++) {
      await new Promise(requestAnimationFrame)
      out.push(sample())
    }
    return out
  }, { action: action.toString(), read: read.toString(), count })
}

describe("disclosure", () => {
  // `window.chevronAngle(selector)` reads the chevron's angle as a person sees it: the computed `rotate`, whatever writes
  // it. `window.pressControl(selector)` presses the control as a person does, with a pointer down, up, and click, so an
  // effect that reads the press sees it too.
  test("a chevron turns with a spring when its control opens and closes, and rests on the stylesheet", async () => {
    const { context, errors, page } = await open()
    const read = () => window.chevronAngle("[data-test=chevron]")
    const opening = await frames(page, () => window.pressControl("[data-test=disclosure]"), read)
    assert.ok(opening.some(frame => frame.angle > 5 && frame.angle < 85), `it turns through the angles between: ${opening.slice(0, 8).map(frame => frame.angle)}`)
    assert.deepEqual(opening.at(-1), { inline: "", angle: 90 })
    const closing = await frames(page, () => window.pressControl("[data-test=disclosure]"), read)
    assert.ok(closing.some(frame => frame.angle > 5 && frame.angle < 85), "it turns back")
    assert.deepEqual(closing.at(-1), { inline: "", angle: 0 })
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a <details> turns its chevron, and data-motion=none and reduced motion turn it at once", async () => {
    const { context, page } = await open()
    const details = await frames(page, () => window.pressControl("[data-test=details] summary"), () => window.chevronAngle("[data-test=details-chevron]"))
    assert.ok(details.some(frame => frame.angle > 5 && frame.angle < 85), "the chevron of a details turns")
    assert.equal(details.at(-1).angle, 90)
    const off = await frames(page, () => window.pressControl("[data-test=off-disclosure]"), () => window.chevronAngle("[data-test=off-chevron]"), 20)
    assert.ok(off.every(frame => frame.angle === 90), "inside data-motion=none it turns at once")
    await page.evaluate(() => window.setReduced(true))
    const reduced = await frames(page, () => window.pressControl("[data-test=disclosure]"), () => window.chevronAngle("[data-test=chevron]"), 20)
    assert.ok(reduced.every(frame => frame.angle === 90), "under reduced motion it turns at once")
    await context.close()
  })
})

describe("leave", () => {
  test("a mark with data-leaving hides, and a copy of it folds away in its place", async () => {
    const { context, errors, page } = await open()
    const before = await page.locator("[data-test=mark]").boundingBox()
    const read = () => {
      const ghost = document.querySelector("[data-test=marks] > [data-motion=none]")
      return {
        original: document.querySelector("[data-test=mark]:not([data-motion])").style.opacity,
        ghost: ghost ? { scale: Number(ghost.style.scale || 1), opacity: Number(ghost.style.opacity || 1), inert: ghost.inert, hidden: ghost.getAttribute("aria-hidden"), rect: ghost.getBoundingClientRect().toJSON() } : null,
      }
    }
    const leaving = await frames(page, () => window.leaveMark(), read, 50)
    assert.ok(leaving.every(frame => frame.original === "0"), "the mark hides at once")
    const ghosts = leaving.map(frame => frame.ghost).filter(Boolean)
    assert.ok(ghosts.length > 3, "a copy plays the fold")
    assert.equal(ghosts[0].inert, true)
    assert.equal(ghosts[0].hidden, "true")
    assert.ok(Math.abs(ghosts[0].rect.x + ghosts[0].rect.width / 2 - (before.x + before.width / 2)) < 2, "the copy folds in the mark's place")
    assert.ok(ghosts.some(ghost => ghost.scale < 0.97 && ghost.opacity < 0.6), "it shrinks toward 90% and fades")
    assert.equal(leaving.at(-1).ghost, null, "the copy goes")
    await page.evaluate(() => window.showMark())
    assert.equal(await page.locator("[data-test=mark]").evaluate(mark => mark.style.opacity), "", "a mark shown again is visible")
    assert.deepEqual(errors, [])
    await context.close()
  })
})

describe("appear", () => {
  test("an element with data-motion-appear comes out of its trigger, narrow, and widens to its place", async () => {
    const { context, errors, page } = await open()
    const pin = await page.locator("[data-test=pin]").boundingBox()
    const read = () => {
      const bubble = document.querySelector("[data-test=bubble]")
      if (!bubble) return null
      const style = getComputedStyle(bubble)
      return { translate: bubble.style.translate, clip: bubble.style.clipPath, opacity: Number(style.opacity), left: bubble.getBoundingClientRect().left }
    }
    const opening = await frames(page, () => window.openBubble(), read, 70)
    const shown = opening.filter(frame => frame && frame.opacity > 0)
    assert.ok(shown.length > 5, "it shows")
    const first = shown[0]
    // It is on the right of the pin, so it starts behind the right edge of the pin and slides out from there.
    assert.ok(first.left < pin.x + pin.width, `the first frame starts behind the pin (left ${first.left}, pin right ${pin.x + pin.width})`)
    assert.match(first.clip, /^inset\(/, "the part behind the pin is clipped")
    assert.deepEqual({ translate: opening.at(-1).translate, clip: opening.at(-1).clip }, { translate: "", clip: "" }, "it rests where its stylesheet puts it")
    const closing = await frames(page, () => window.closeBubble(), () => document.querySelector("[data-test=spot] > [data-motion=none]") !== null, 70)
    assert.equal(closing[0], true, "a copy plays the exit")
    assert.equal(closing.at(-1), false, "the copy goes")
    assert.deepEqual(errors, [])
    await context.close()
  })
})

describe("press target", () => {
  test("a control with data-motion-press-target squashes the element that draws it", async () => {
    const { context, page } = await open()
    const box = await page.locator("[data-test=press-target]").boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(120)
    const pressed = await page.evaluate(() => ({ glass: document.querySelector("[data-test=glass]").style.scale, icon: document.querySelector("[data-test=press-target] svg").style.scale }))
    assert.ok(Number(pressed.glass) < 0.99 && Number(pressed.glass) > 0.9, `the glass squashes (${pressed.glass})`)
    assert.equal(pressed.icon, "", "its icon does not")
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector("[data-test=glass]").style.scale, undefined, { timeout: 5000 })
    await context.close()
  })
})

describe("installs", () => {
  // Two separate bundles of `@vite-hub/ui/motion`, as a page has when the app and the page pill each bring one.
  const bundle = async (name) => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("../../src/motion.ts", import.meta.url)), formats: ["iife"], name } },
    })
    return result[0].output[0].code
  }
  const copies = Promise.all([bundle("MotionApp"), bundle("MotionPill")])

  /** A page with a page button, a host with a button in its light DOM and one in its shadow root, and both bundles. */
  async function openCopies() {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent(`<button id="page">Page</button><div id="host"><button id="light">Light</button></div>`)
    for (const code of await copies) await page.addScriptTag({ content: code })
    await page.evaluate(() => {
      const host = document.querySelector("#host")
      host.attachShadow({ mode: "open" }).innerHTML = `<slot></slot><button id="shadow">Shadow</button>`
      window.pressed = []
      // Each copy counts the presses that it starts, with an effect of its own.
      for (const name of ["MotionApp", "MotionPill"]) {
        window[name].defineMotionEffect({ name: `count-${name}`, selector: "button", press: (element) => { window.pressed.push(`${name}:${element.id}`); return { release() {} } } })
      }
      window.press = (element) => {
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, isPrimary: true, pointerId: 1, button: 0, buttons: 1 }))
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, isPrimary: true, pointerId: 1, button: 0 }))
      }
      window.pressAll = () => {
        window.pressed = []
        const host = document.querySelector("#host")
        for (const element of [document.querySelector("#page"), document.querySelector("#light"), host.shadowRoot.querySelector("#shadow")]) window.press(element)
        return window.pressed
      }
    })
    return { context, page }
  }

  test("a surface that installs only its shadow root does not move the page around it", async () => {
    const { context, page } = await openCopies()
    const pressed = await page.evaluate(() => {
      window.MotionPill.installMotion(document.querySelector("#host").shadowRoot)
      return window.pressAll()
    })
    assert.deepEqual(pressed, ["MotionPill:shadow"])
    await context.close()
  })

  test("an installed element covers its children and the shadow roots in it", async () => {
    const { context, page } = await openCopies()
    const pressed = await page.evaluate(() => {
      window.MotionPill.installMotion(document.querySelector("#host"))
      return window.pressAll()
    })
    assert.deepEqual(pressed, ["MotionPill:light", "MotionPill:shadow"])
    await context.close()
  })

  test("two copies that cover the same element press it once", async () => {
    const { context, page } = await openCopies()
    const pressed = await page.evaluate(() => {
      window.MotionApp.installMotion()
      window.MotionPill.installMotion(document.querySelector("#host"))
      return window.pressAll()
    })
    assert.deepEqual(pressed, ["MotionApp:page", "MotionApp:light", "MotionApp:shadow"])
    await context.close()
  })
})

describe("shake", () => {
  test("shake() moves a box out to 5px on each side and back, and does nothing under reduced motion", async () => {
    const { context, page } = await open()
    const offsets = await frames(page, () => window.shakeBox(), () => Number.parseFloat(document.querySelector("[data-test=box]").style.translate || "0"), 40)
    assert.ok(Math.min(...offsets) < -3 && Math.max(...offsets) > 3, `it moves both ways: ${offsets.map(value => value.toFixed(1)).join(" ")}`)
    assert.ok(Math.max(...offsets.map(Math.abs)) <= 5.01, "never past 5px")
    assert.equal(offsets.at(-1), 0, "it ends at rest")
    await page.evaluate(() => window.setReduced(true))
    const reduced = await frames(page, () => window.shakeBox(), () => document.querySelector("[data-test=box]").style.translate, 20)
    assert.ok(reduced.every(value => value === ""))
    await context.close()
  })
})
