import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
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
  await page.goto(`${base}appear.html${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

async function sampleTooltips(page) {
  await page.evaluate(() => {
    const frames = []
    let running = true
    const boxes = () => {
      const found = new Set()
      for (const element of document.querySelectorAll("[role=tooltip]")) {
        const hidden = getComputedStyle(element).clipPath === "inset(50%)"
        found.add(hidden ? element.parentElement : element)
      }
      for (const ghost of document.querySelectorAll("[data-motion=none][aria-hidden=true]")) {
        const box = ghost.matches("[data-reka-popper-content-wrapper]") ? ghost.firstElementChild : ghost
        if (box) found.add(box)
      }
      return [...found].filter(box => box && box.isConnected && !box.hidden && getComputedStyle(box).display !== "none")
    }
    const read = () => {
      frames.push(boxes().map((box) => {
        const rect = box.getBoundingClientRect()
        const style = getComputedStyle(box)
        return {
          ghost: !!box.closest("[data-motion=none][aria-hidden=true]"),
          text: [...box.childNodes].filter(node => node.nodeType === Node.TEXT_NODE || (node instanceof Element && getComputedStyle(node).clipPath !== "inset(50%)")).map(node => node.textContent).join("").trim(),
          id: box.dataset.sampleId ??= String(Math.random()),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          offsetWidth: box.offsetWidth,
          clip: style.clipPath,
          opacity: Number(style.opacity),
          translate: box.style.translate,
          scale: box.style.scale,
          old: box.querySelector(":scope > span[aria-hidden=true]")?.textContent,
          label: [...box.children].filter(child => getComputedStyle(child).clipPath !== "inset(50%)").map(child => Number(getComputedStyle(child).opacity)),
        }
      }))
      if (running) requestAnimationFrame(read)
    }
    requestAnimationFrame(read)
    window.stopTooltips = () => {
      running = false
      return frames
    }
  })
  return { stop: () => page.evaluate(() => window.stopTooltips()) }
}

async function rectOf(page, selector) {
  return page.locator(selector).first().boundingBox()
}

async function hover(page, selector) {
  const box = await rectOf(page, selector)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 })
}

async function settled(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll("[data-motion=none][aria-hidden=true]")].length
    && [...document.querySelectorAll("[role=tooltip]")].every((element) => {
      const box = getComputedStyle(element).clipPath === "inset(50%)" ? element.parentElement : element
      return !box.style.translate && !box.style.scale && !box.style.clipPath && !box.style.opacity
    }), undefined, { timeout: 10_000 })
}

describe("tooltip", async () => {
  test("a UTooltip rises from behind its trigger, narrow, then widens to where Floating UI put it", async () => {
    const { context, errors, page } = await open()
    const trigger = await rectOf(page, "[data-test='tool-Share']")
    const trace = await sampleTooltips(page)
    await hover(page, "[data-test='tool-Share']")
    await page.waitForSelector("[data-reka-popper-content-wrapper]")
    await settled(page)
    const frames = (await trace.stop()).filter(frame => frame.length)
    const visible = frames.map(frame => frame.find(box => box.text === "Share")).filter(box => box && box.opacity > 0)
    const first = visible[0]
    const last = await page.locator("[data-reka-popper-content-wrapper] > *").evaluate((box) => {
      const rect = box.getBoundingClientRect()
      return { bottom: rect.bottom, width: rect.width, offsetWidth: box.offsetWidth, translate: box.style.translate, scale: box.style.scale, clip: getComputedStyle(box).clipPath }
    })
    assert.ok(first.bottom > trigger.y + 4, `the first frame sits low, behind the trigger (bottom ${first.bottom}, trigger top ${trigger.y})`)
    assert.notEqual(first.clip, "none", "the first frame is clipped at the trigger")
    assert.ok(first.width < last.width * 0.75, `the first frame is narrow (${first.width} of ${last.width})`)
    assert.ok(first.label.every(opacity => opacity < 0.05), "the label is not shown while it rises")
    assert.ok(last.bottom <= trigger.y, "it ends above its trigger")
    assert.ok(Math.abs(last.width - last.offsetWidth) < 0.5, "it ends at full width")
    assert.equal(last.translate, "")
    assert.equal(last.scale, "")
    assert.equal(last.clip, "none")
    const tops = visible.map(box => box.top)
    assert.ok(tops.filter((top, index) => index && top < tops[index - 1] - 0.1).length >= 4, "it rises over several frames")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("hovering the next trigger slides the tooltip over, and leaving sinks it back", async () => {
    const { context, page } = await open()
    await hover(page, "[data-test='tool-Edit']")
    await page.waitForSelector("[data-reka-popper-content-wrapper]")
    await settled(page)
    const from = await rectOf(page, "[data-test='tool-Edit']")
    const to = await rectOf(page, "[data-test='tool-Notifications']")
    const trace = await sampleTooltips(page)
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
    await page.waitForTimeout(100)
    await settled(page)
    const frames = await trace.stop()
    assert.deepEqual(frames.filter(frame => !frame.some(box => box.opacity > 0.5)).length, 0, "no frame is without a tooltip")
    const centers = frames.map(frame => frame.find(box => !box.ghost && box.opacity > 0) ?? frame[0]).map(box => (box.left + box.right) / 2)
    const start = from.x + from.width / 2
    const end = to.x + to.width / 2
    const between = centers.filter(center => center > start + 4 && center < end - 4)
    assert.ok(between.length >= 4, `it slides through ${between.length} frames between the triggers`)
    assert.ok(Math.abs(centers.at(-1) - end) < 1, "it ends over the new trigger")
    const widths = frames.map(frame => frame.find(box => !box.ghost)?.width).filter(Boolean)
    assert.ok(new Set(widths.map(width => Math.round(width))).size > 4, "its width changes over several frames")

    const sink = await sampleTooltips(page)
    await page.mouse.move(450, 880)
    await settled(page)
    const leaving = (await sink.stop()).flat().filter(box => box.ghost)
    assert.ok(leaving.length > 4, "a ghost plays the exit")
    assert.ok(Math.max(...leaving.map(box => box.top)) > leaving[0].top + 8, "the ghost sinks")
    assert.ok(Math.min(...leaving.map(box => box.width)) < leaving[0].width * 0.7, "the ghost narrows")
    await context.close()
  })

  test("a tooltip in another row rises on its own, it does not slide over from the last one", async () => {
    const { context, page } = await open()
    await hover(page, "[data-test='tool-Edit']")
    await page.waitForSelector("[data-reka-popper-content-wrapper]")
    await settled(page)
    const trigger = await rectOf(page, "[data-test='own-Edit']")
    const trace = await sampleTooltips(page)
    await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2, { steps: 12 })
    await settled(page)
    const own = (await trace.stop()).flat().filter(box => !box.ghost && box.opacity > 0 && box.text === "Edit" && box.top > trigger.y - 60)
    assert.ok(own.length > 0)
    assert.ok(own[0].bottom > trigger.y + 4, `its first frame sits behind its own trigger (bottom ${own[0].bottom}, trigger top ${trigger.y})`)
    await context.close()
  })

  test("one tooltip element for many triggers moves to the next trigger as the same element", async () => {
    const { context, page } = await open()
    await hover(page, "[data-test='own-Edit']")
    await settled(page)
    const element = await page.locator("#own-tip").elementHandle()
    const opened = await page.locator("#own-tip").evaluate(node => node.getBoundingClientRect().left)
    await page.evaluate(() => {
      window.ownTipEvents = []
      new MutationObserver(records => window.ownTipEvents.push(...records.map(record => record.attributeName))).observe(document.querySelector("#own-tip"), { attributes: true, attributeFilter: ["data-open", "hidden"] })
    })
    const trace = await sampleTooltips(page)
    await hover(page, "[data-test='own-Notifications']")
    await page.waitForTimeout(100)
    await settled(page)
    const frames = await trace.stop()
    assert.deepEqual(await page.evaluate(() => window.ownTipEvents), [], "it does not close and open again")
    assert.ok(await element.evaluate(node => node.isConnected && node === document.querySelector("#own-tip")))
    const lefts = frames.map(frame => frame.find(box => !box.ghost)?.left).filter(left => left !== undefined)
    const final = lefts.at(-1)
    assert.ok(lefts.filter(left => left > opened + 2 && left < final - 2).length >= 4, "the same box slides over several frames")
    const outgoing = frames.flat().filter(box => box.old)
    assert.ok(outgoing.length && outgoing.every(box => box.old === "Edit"), "the outgoing label comes from the previous trigger")
    await context.close()
  })

  test("turning on reduced motion cancels queued tooltip entry stages and clears an active exit", async () => {
    const { context, page } = await open()
    await page.locator("[data-test=speed]").click()
    await hover(page, "[data-test='tool-Share']")
    const box = page.locator("[data-reka-popper-content-wrapper] > *")
    await page.waitForFunction(() => !!document.querySelector("[data-reka-popper-content-wrapper] > *")?.style.scale)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches)
    const trace = await sampleTooltips(page)
    await page.waitForTimeout(1100)
    const frames = (await trace.stop()).flat()
    assert.ok(frames.length && frames.every(frame => !frame.scale && !frame.translate && frame.label.every(opacity => opacity === 1)))

    await page.emulateMedia({ reducedMotion: "no-preference" })
    await box.waitFor()
    await page.keyboard.press("Escape")
    const ghost = page.locator("[data-motion=none][aria-hidden=true]")
    await ghost.waitFor()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await ghost.waitFor({ state: "detached", timeout: 500 })
    assert.equal(await ghost.count(), 0)
    await context.close()
  })

  for (const reducedMotion of ["no-preference", "reduce"]) {
    test(`the native ui-sdk tooltip has a visible inert exit under ${reducedMotion}`, async () => {
      const { context, page } = await open("", { reducedMotion })
      await page.locator("[data-test=speed]").click()
      await hover(page, "[data-test=kit-trigger]")
      const live = page.locator("[role=tooltip]:popover-open")
      await live.waitFor()
      await settled(page)
      const trace = await sampleTooltips(page)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())))
      await page.keyboard.press("Escape")
      await live.waitFor({ state: "hidden" })
      await settled(page)
      const frames = (await trace.stop()).flat()
      const before = frames.find(box => !box.ghost && box.text === "Native tooltip")
      const exit = frames.filter(box => box.ghost && box.text === "Native tooltip")
      assert.ok(before && exit.length > 2 && exit.every(box => box.width > 0))
      assert.ok(Math.abs(exit[0].left - before.left) < 3, "the exit begins at the live tooltip")
      if (reducedMotion === "reduce") assert.ok(exit.some(box => box.opacity > 0 && box.opacity < 1))
      await context.close()
    })
  }

  test("under reduced motion the tooltip only crossfades", async () => {
    const { context, page } = await open("", { reducedMotion: "reduce" })
    const trace = await sampleTooltips(page)
    await hover(page, "[data-test='tool-Duplicate']")
    await page.waitForSelector("[data-reka-popper-content-wrapper]")
    await settled(page)
    const boxes = (await trace.stop()).flat()
    assert.ok(boxes.every(box => !box.translate && !box.scale && box.clip === "none"), "it does not travel, scale, or clip")
    const opacities = boxes.map(box => box.opacity)
    assert.ok(opacities.some(opacity => opacity > 0.05 && opacity < 0.95), "it fades in")
    assert.equal(await page.locator("[data-reka-popper-content-wrapper] > *").evaluate(box => getComputedStyle(box).opacity), "1")
    await context.close()
  })

  test("data-motion=none keeps a tooltip still", async () => {
    const { context, page } = await open()
    const trace = await sampleTooltips(page)
    await hover(page, "[data-test='tool-still']")
    await page.waitForSelector("[data-reka-popper-content-wrapper]")
    await page.waitForTimeout(300)
    const boxes = (await trace.stop()).flat().filter(box => box.text === "Still")
    assert.ok(boxes.length > 0)
    assert.ok(boxes.every(box => !box.translate && !box.scale && box.clip === "none" && box.opacity === 1), "it shows at once")
    await context.close()
  })
})

describe("reading surfaces", async () => {
  async function firstFrame(page, trigger, selector) {
    await page.evaluate((selector) => {
      window.firstFrame = new Promise((resolve) => {
        const look = () => {
          const element = document.querySelector(selector)
          if (!element) return requestAnimationFrame(look)
          const read = () => {
            const style = getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            return { opacity: Number(style.opacity), animation: style.animationName, transform: style.transform, rect: [rect.left, rect.top, rect.width, rect.height] }
          }
          const first = read()
          setTimeout(() => resolve({ first, later: read() }), 400)
        }
        requestAnimationFrame(look)
      })
    }, selector)
    await page.locator(`[data-test='${trigger}']`).click()
    return page.evaluate(() => window.firstFrame)
  }

  for (const [name, trigger, selector] of [
    ["a UModal", "open-modal", "[role=dialog]"],
    ["a USlideover", "open-slideover", "[role=dialog]"],
    ["a UPopover", "open-popover", "[data-reka-popper-content-wrapper] > *"],
    ["a UDropdownMenu", "open-menu", "[role=menu]"],
  ]) {
    test(`${name} is fully shown in the first frame after it opens`, async () => {
      const { context, page } = await open()
      const { first, later } = await firstFrame(page, trigger, selector)
      assert.equal(first.animation, "none")
      assert.equal(first.opacity, 1)
      assert.deepEqual(first.rect, later.rect, "it does not move or grow after the first frame")
      await context.close()
    })
  }

  test("the backdrop of a UModal is fully shown in the first frame", async () => {
    const { context, page } = await open()
    await page.evaluate(() => {
      window.overlay = new Promise((resolve) => {
        const look = () => {
          const element = document.querySelector(".fixed.inset-0[data-state=open]:not([role=dialog])")
          if (!element) return requestAnimationFrame(look)
          const style = getComputedStyle(element)
          resolve({ animation: style.animationName, opacity: Number(style.opacity) })
        }
        requestAnimationFrame(look)
      })
    })
    await page.locator("[data-test=open-modal]").click()
    assert.deepEqual(await page.evaluate(() => window.overlay), { animation: "none", opacity: 1 })
    await context.close()
  })
})

describe("toast", async () => {
  async function sampleToasts(page, selector) {
    await page.evaluate((selector) => {
      const frames = []
      let running = true
      const read = () => {
        frames.push([...document.querySelectorAll(`${selector}, [data-motion=none][aria-hidden=true]`)].filter(element => element.matches(selector) || element.matches("li")).map((element) => {
          element.dataset.sampleId ??= String(Math.random())
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const [x = "0", y = "0"] = style.translate.split(" ")
          return { id: element.dataset.sampleId, ghost: element.matches("[data-motion=none]"), x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0, left: rect.left, top: rect.top, opacity: Number(style.opacity) }
        }))
        if (running) requestAnimationFrame(read)
      }
      requestAnimationFrame(read)
      window.stopToasts = () => {
        running = false
        return frames
      }
    }, selector)
    return { stop: () => page.evaluate(() => window.stopToasts()) }
  }

  const consoleToast = "[data-slot=toast]"
  const toastsSettled = page => page.waitForFunction(() => [...document.querySelectorAll("[data-slot=toast], [role=region] li")].every(element => !element.style.translate && !element.style.opacity) && !document.querySelector("[data-motion=none][aria-hidden=true]"), undefined, { timeout: 10_000 })

  test("a Console toast comes in from the bottom edge, and the toast before it makes room with a spring", async () => {
    const { context, errors, page } = await open()
    const trace = await sampleToasts(page, consoleToast)
    await page.locator("[data-test=console-toast]").click()
    await page.waitForSelector(consoleToast)
    await toastsSettled(page)
    const frames = (await trace.stop()).filter(frame => frame.length)
    const first = frames[0][0]
    assert.ok(first.y > 40, `it starts below its place, toward the bottom edge (${first.y}px)`)
    assert.ok(frames.filter(frame => frame[0].y > 0.5 && frame[0].y < first.y - 0.5).length >= 4, "it travels over several frames")

    const second = await sampleToasts(page, consoleToast)
    await page.locator("[data-test=console-toast]").click()
    await page.waitForFunction(() => document.querySelectorAll("[data-slot=toast]").length === 2)
    await toastsSettled(page)
    const moves = (await second.stop()).flat().filter(box => box.id === first.id && !box.ghost)
    const offsets = moves.map(box => box.y)
    assert.ok(offsets.filter(y => Math.abs(y) > 0.5).length >= 4, "the older toast moves to its new place over several frames")
    assert.ok(Math.max(...offsets) > 10, `it starts from where it was, below its new place (${Math.max(...offsets)}px)`)
    assert.ok(Math.min(...offsets) < -0.05, "the spring passes its new place once")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a dismissed Console toast leaves past the right side, and the other one closes the gap", async () => {
    const { context, page } = await open("", { viewport: { width: 390, height: 900 } })
    await page.locator("[data-test=console-toast]").click()
    await page.locator("[data-test=console-toast]").click()
    await page.waitForFunction(() => document.querySelectorAll("[data-slot=toast]").length === 2)
    await toastsSettled(page)
    const trace = await sampleToasts(page, consoleToast)
    await page.evaluate(() => window.consoleToast.remove(window.consoleToast.toasts.value[1].id))
    await toastsSettled(page)
    const boxes = (await trace.stop()).flat()
    const ghost = boxes.filter(box => box.ghost)
    assert.ok(ghost.length >= 3, "a ghost plays the exit")
    assert.ok(ghost.at(-1).x > ghost[0].x + 20, `it leaves right, toward the side the toaster sits at (${JSON.stringify(ghost.map(box => box.x))})`)
    assert.ok(ghost.every(box => box.y === 0), "it does not cross the other toast")
    const other = boxes.filter(box => !box.ghost && Math.abs(box.y) > 0.5)
    assert.ok(other.length >= 3, "the other toast springs to its new place")
    await context.close()
  })

  test("a Nuxt UI toast at the top comes in from the top edge", async () => {
    const { context, page } = await open()
    const trace = await sampleToasts(page, "[role=region] li")
    await page.locator("[data-test=nuxt-toast]").click()
    await page.waitForSelector("[role=region] li")
    await toastsSettled(page)
    const frames = (await trace.stop()).filter(frame => frame.length)
    assert.ok(frames[0][0].y < -20, `it starts above its place (${frames[0][0].y}px)`)
    assert.equal(await page.locator("[role=region] li").first().evaluate(element => getComputedStyle(element).animationName), "none")
    await context.close()
  })

  for (const [button, selector] of [["console-toast", consoleToast], ["nuxt-toast", "[role=region] li"]]) {
    test(`${button} follows a swipe during entry and exits from its release position`, async () => {
      const { context, page } = await open()
      await page.locator("[data-test=speed]").click()
      const trace = await sampleToasts(page, selector)
      await page.locator(`[data-test=${button}]`).click()
      const element = page.locator(selector).first()
      await element.waitFor()
      await page.waitForFunction(selector => {
        const element = document.querySelector(selector)
        const rect = element?.getBoundingClientRect()
        return element?.style.translate && rect?.top > 0 && rect.top + 15 < innerHeight
      }, selector)
      const start = await element.boundingBox()
      const x = start.x + 20
      const y = start.y + 10
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 110, y, { steps: 4 })
      const dragged = await element.boundingBox()
      assert.ok(dragged.x > start.x + 95, "the toast tracks the pointer")
      await page.mouse.up()
      await element.waitFor({ state: "detached" })
      await toastsSettled(page)
      const exit = (await trace.stop()).flat().filter(box => box.ghost)
      assert.ok(exit.length > 2 && Math.abs(exit[0].left - dragged.x) < 20, "the exit begins where the pointer let go")
      assert.ok(exit.at(-1).left > exit[0].left + 40, "the exit continues right")
      await context.close()
    })
  }

  test("under reduced motion a toast crossfades in place", async () => {
    const { context, page } = await open("", { reducedMotion: "reduce" })
    const trace = await sampleToasts(page, consoleToast)
    await page.locator("[data-test=console-toast]").click()
    await page.waitForSelector(consoleToast)
    await toastsSettled(page)
    const boxes = (await trace.stop()).flat()
    assert.ok(boxes.every(box => box.y === 0 && box.x === 0), "it does not travel")
    assert.ok(boxes.some(box => box.opacity > 0.05 && box.opacity < 0.95), "it fades in")
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each appear effect at ¼×", { timeout: 600_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const toolbar = { selector: "[data-test=toolbar]", pad: [48, 16] }
    const tooltipSteps = async (page, slow) => {
      await hover(page, "[data-test='tool-Edit']")
      await page.waitForTimeout(900 * slow)
      const to = await rectOf(page, "[data-test='tool-Notifications']")
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
      await page.waitForTimeout(900 * slow)
      await page.mouse.move(to.x + to.width / 2, to.y - 120, { steps: 4 })
      await page.waitForTimeout(800 * slow)
    }
    const toasterSteps = async (page, slow) => {
      await page.locator("[data-test=console-toast]").click()
      await page.waitForTimeout(700 * slow)
      await page.locator("[data-test=console-toast]").click()
      await page.waitForTimeout(700 * slow)
      await page.evaluate(() => window.consoleToast.remove(window.consoleToast.toasts.value[0].id))
      await page.waitForTimeout(800 * slow)
    }
    const modalSteps = async (page, slow) => {
      await page.locator("[data-test=open-modal]").click()
      await page.waitForTimeout(700 * slow)
      await page.keyboard.press("Escape")
      await page.waitForTimeout(500 * slow)
    }
    const toaster = { area: { x: 440, y: 700, width: 460, height: 200 } }
    const modal = { area: { x: 0, y: 0, width: 900, height: 900 } }
    const subjects = [
      { name: "tooltip-new", ...toolbar, steps: tooltipSteps },
      { name: "tooltip-today", query: "?mode=today", ...toolbar, steps: tooltipSteps },
      { name: "toaster-new", ...toaster, steps: toasterSteps },
      { name: "toaster-today", query: "?mode=today", ...toaster, steps: toasterSteps },
      { name: "modal-new", ...modal, steps: modalSteps },
      { name: "modal-today", query: "?mode=today", ...modal, steps: modalSteps },
    ]
    if (process.env.MOTION_PROTOTYPE) {
      subjects.push({
        name: "tooltip-prototype",
        url: pathToFileURL(process.env.MOTION_PROTOTYPE).href,
        selector: "#v-toolbar-bar",
        pad: [48, 16],
        prototype: true,
        steps: async (page, slow) => {
          const buttons = page.locator("#v-toolbar-bar button")
          const first = await buttons.nth(0).boundingBox()
          await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 4 })
          await page.waitForTimeout(900 * slow)
          const to = await buttons.nth(3).boundingBox()
          await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
          await page.waitForTimeout(900 * slow)
          await page.mouse.move(to.x + to.width / 2, to.y - 120, { steps: 4 })
          await page.waitForTimeout(800 * slow)
        },
      })
    }
    const warm = await open()
    await warm.context.close()
    for (const subject of subjects) await record(subject)
    const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args])
    for (const [name, parts] of [["tooltip", ["today", "new", "prototype"]], ["toaster", ["today", "new"]], ["modal", ["today", "new"]]]) {
      const inputs = parts.map(part => join(recordDir, `${name}-${part}.mp4`)).filter(file => existsSync(file))
      const filter = `${inputs.map((_, index) => `[${index}:v]scale=-2:360,pad=iw+16:ih:8:0:white[v${index}]`).join(";")};${inputs.map((_, index) => `[v${index}]`).join("")}hstack=inputs=${inputs.length},pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white[out]`
      ffmpeg(...inputs.flatMap(file => ["-i", file]), "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(recordDir, `${name}.mp4`))
    }
  })
}

async function record({ name, query = "", url, selector, pad = [20, 20], area, prototype, steps }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } })
  const page = await context.newPage()
  if (url) await page.goto(url)
  else {
    await page.goto(`${base}appear.html${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  }
  if (prototype) {
    await page.locator(selector).evaluate((node) => {
      const section = node.closest("section")
      section.querySelector("[data-k=mode] [data-v=tactile]").click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    })
  }
  else if (query.includes("today")) {
    const cdp = await context.newCDPSession(page)
    await cdp.send("Animation.enable")
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.25 })
  }
  else await page.locator("[data-test=speed]").click()
  const arrow = encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 14 20\"><path d=\"M1 1v16l4-4 3 6 2-1-3-6h6z\" fill=\"#111\" stroke=\"#fff\" stroke-width=\"1.2\" stroke-linejoin=\"round\"/></svg>")
  await page.addStyleTag({ content: `#record-pointer{position:fixed;left:0;top:0;z-index:2147483647;width:14px;height:20px;background:url("data:image/svg+xml,${arrow}");pointer-events:none}` })
  await page.evaluate(() => {
    const tip = document.body.appendChild(Object.assign(document.createElement("div"), { id: "record-pointer" }))
    addEventListener("mousemove", event => (tip.style.translate = `${event.clientX}px ${event.clientY}px`))
  })
  await page.mouse.move(0, 0)
  if (selector) await page.locator(selector).scrollIntoViewIfNeeded()
  await page.waitForTimeout(600)
  const box = selector ? await page.locator(selector).boundingBox() : area
  const clip = selector
    ? { x: Math.max(0, Math.floor(box.x - pad[1])), y: Math.max(0, Math.floor(box.y - pad[0])), width: Math.ceil(box.width + 2 * pad[1]), height: Math.ceil(box.height + 2 * pad[0]) }
    : area
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
  await page.waitForTimeout(300)
  await steps(page, 4)
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
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(recordDir, `${name}.mp4`)]).toString())
  ffmpeg("-i", join(recordDir, `${name}.mp4`), "-vf", `fps=24/${seconds.toFixed(2)},tile=8x3:padding=4:color=white`, "-frames:v", "1", join(recordDir, `${name}.png`))
  return { frames: frames.length }
}
