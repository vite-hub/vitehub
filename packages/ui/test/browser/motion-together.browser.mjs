import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
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

async function open() {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(base)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  await page.locator("[data-test=together-tabs]").scrollIntoViewIfNeeded()
  return { context, errors, page }
}

async function sample(page, selector, read) {
  await page.evaluate(({ selector, source }) => {
    const read = new Function(`return (${source})`)()
    const frames = []
    let running = true
    const step = () => {
      const element = document.querySelector(selector)
      if (element) frames.push(read(element))
      if (running) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    window.stopTogether = () => {
      running = false
      return frames
    }
  }, { selector, source: read.toString() })
  return { stop: () => page.evaluate(() => window.stopTogether()) }
}

function clean(page, selector) {
  return page.waitForFunction(selector => [document.querySelector(selector), ...document.querySelectorAll(`${selector} *`)].every(node => !node.style?.translate && !node.style?.scale && !node.style?.rotate && !node.style?.filter && !node.style?.clipPath), selector, { timeout: 10_000 })
}

async function center(page, selector) {
  const box = await page.locator(selector).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

describe("effects together", () => {
  test("UTabs with tooltips: the tooltip rises over its tab, a click moves the indicator under the new tab, and both settle", async () => {
    const { context, errors, page } = await open()
    const target = await center(page, "[data-test=together-tab-code]")
    await page.mouse.move(target.x, target.y, { steps: 4 })
    const tooltip = page.locator("[role=tooltip]", { hasText: "Show the source" })
    await tooltip.waitFor({ state: "attached" })
    await page.waitForFunction(() => [...document.querySelectorAll("[data-reka-popper-content-wrapper] *")].some(node => node.style.translate || node.style.clipPath))
    const trace = await sample(page, "[data-test=together-tabs] [data-slot=indicator]", element => element.style.translate || element.style.scale)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector("[data-test=together-tabs] [role=tab][aria-selected=true]")?.textContent?.includes("Code"))
    await clean(page, "[data-test=together-tabs]")
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-reka-popper-content-wrapper] *, [data-motion=none][aria-hidden=true]")].some(node => node.style.translate || node.style.scale || node.style.clipPath))
    const frames = await trace.stop()
    assert.ok(frames.some(Boolean), "the indicator travels with the select effect while the tooltip is open")
    const indicator = await page.locator("[data-test=together-tabs] [data-slot=indicator]").boundingBox()
    const tab = await page.locator("[data-test=together-tabs] [role=tab][aria-selected=true]").boundingBox()
    assert.ok(Math.abs(indicator.x - tab.x) <= 1 && Math.abs(indicator.width - tab.width) <= 1, `the indicator lands under the Code tab (${indicator.x}/${indicator.width}, tab ${tab.x}/${tab.width})`)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a USwitch in a toolbar: the knob travels and lands, the switch does not squash, and the pressed button next to it keeps its own state", async () => {
    const { context, errors, page } = await open()
    const control = "[data-test=together-switch][role=switch]"
    const knob = `${control} [data-slot=thumb]`
    const before = await page.locator(knob).boundingBox()
    const trace = await sample(page, control, element => ({ scale: getComputedStyle(element).scale, knob: element.querySelector("[data-slot=thumb]").style.translate }))
    await page.locator(control).click()
    await page.locator("[data-test=together-bold]").click()
    await page.waitForTimeout(2400)
    await clean(page, "[data-test=together-toolbar]")
    const frames = await trace.stop()
    const after = await page.locator(knob).boundingBox()
    assert.equal(await page.locator(control).getAttribute("aria-checked"), "true")
    assert.equal(await page.locator("[data-test=together-bold]").getAttribute("aria-pressed"), "true")
    assert.ok(after.x - before.x > 10, `the knob moves to the on side (${before.x} → ${after.x})`)
    assert.ok(frames.some(frame => frame.knob), "the switch effect moves the knob")
    assert.ok(frames.every(frame => frame.scale === "none" || frame.scale === "1"), "the switch itself does not squash")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a loading UButton in a MotionList row: the row moves to its new place while the spinner draws in, and both settle", async () => {
    const { context, errors, page } = await open()
    const rowBefore = await page.locator("[data-test=together-row-1]").boundingBox()
    const trace = await sample(page, "[data-test=together-row-1]", (element) => {
      const spinner = element.querySelector("svg.animate-spin")
      return {
        translate: getComputedStyle(element).translate,
        svgs: element.querySelectorAll("button > svg").length,
        dash: spinner ? getComputedStyle(spinner.querySelector("path, circle")).strokeDashoffset : "",
      }
    })
    await page.locator("[data-test=together-publish-1]").click()
    await page.waitForSelector("[data-test=together-row-3]")
    await page.waitForTimeout(900)
    await clean(page, "[data-test=together-list]")
    const frames = await trace.stop()
    const rowAfter = await page.locator("[data-test=together-row-1]").boundingBox()
    assert.ok(rowAfter.y - rowBefore.y > 10, `the row has its new place below the new file (${rowBefore.y} → ${rowAfter.y})`)
    assert.ok(frames.some(frame => frame.translate !== "none"), "MotionList moves the row from its old place")
    assert.equal(frames.at(-1).translate, "none", "the row settles in its place")
    const dashes = frames.map(frame => Number.parseFloat(frame.dash)).filter(Number.isFinite)
    assert.ok(dashes.some(value => value > 0 && value < 1), `the spinner draws its stroke while the row moves: ${dashes.slice(0, 8)}`)
    assert.ok(frames.some(frame => frame.svgs === 2), "the old icon blurs out while the spinner comes in")
    assert.equal(frames.at(-1).svgs, 1, "only the spinner is left")
    assert.match(await page.locator("[data-test=together-publish-1]").textContent(), /Publishing/)
    assert.deepEqual(errors, [])
    await context.close()
  })
})
