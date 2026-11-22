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
const ui = fileURLToPath(new URL("../../", import.meta.url))
const repo = fileURLToPath(new URL("../../../../", import.meta.url))
const uploadsDir = join(repo, "packages/vite-hub/src/console/runtime/components/")
const nuxtUIRequire = createRequire(fileURLToPath(import.meta.resolve("@nuxt/ui/vite")))

const todayId = join(uploadsDir, "console-media-uploads.today.vue")
const consoleParts = {
  name: "motion-lists-console-parts",
  enforce: "pre",
  resolveId(id) {
    if (id === "@vite-hub/ui") return "\0vitehub-ui-parts"
    if (id === "/@uploads-today") return todayId
  },
  load(id) {
    if (id === "\0vitehub-ui-parts") {
      return `export { MotionList } from ${JSON.stringify(join(ui, "src/components/motion-list.ts"))}\nexport { Progress } from ${JSON.stringify(join(ui, "src/components/progress.ts"))}\n`
    }
    if (id === todayId) {
      const base = process.env.MOTION_TODAY_REF ?? "origin/feat/ui-motion-core"
      return execFileSync("git", ["show", `${base}:packages/vite-hub/src/console/runtime/components/console-media-uploads.vue`], { cwd: repo, encoding: "utf8" })
    }
  },
}

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [consoleParts, vue(), nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, router: false, ui: vitehubTheme })],
  resolve: { alias: [{ find: /^@iconify\/vue$/, replacement: nuxtUIRequire.resolve("@iconify/vue") }] },
  root,
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
})
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

async function open(query = "", options = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2, ...options })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}lists.html${query}`)
  await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
  return { context, errors, page }
}

async function trace(page, { click, target, frames = 90, read }) {
  return page.evaluate(async ({ click, target, frames, read }) => {
    const reader = new Function("element", `return (${read})(element)`)
    document.querySelector(click).click()
    let element
    for (let index = 0; index < 20 && !element; index++) {
      await new Promise(resolve => queueMicrotask(resolve))
      element = document.querySelector(target)
    }
    const values = [reader(element)]
    for (let index = 0; index < frames; index++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      values.push(reader(element))
    }
    return values
  }, { click, target, frames, read: read.toString() })
}

const translateY = (element) => {
  const value = getComputedStyle(element).translate
  return value === "none" ? 0 : Number.parseFloat(value.split(" ")[1] ?? "0")
}

function steps(values) {
  return values.slice(1).map((value, index) => Math.abs(value - values[index]))
}

describe("MotionList", () => {
  test("after an insert, neighbors spring from where they were to their layout place", async () => {
    const { context, errors, page } = await open()
    const before = await page.locator("[data-id='1']").boundingBox()
    const values = await trace(page, { click: "[data-test=add]", target: "[data-id='1']", read: translateY })
    const after = await page.locator("[data-id='1']").boundingBox()
    const shift = after.y - before.y
    assert.ok(shift > 40, `the row moved down by one row (${shift}px)`)
    assert.ok(Math.abs(values[0] + shift) < 1, `it starts at -${shift}px, not ${values[0]}`)
    assert.ok(Math.max(...steps(values)) < shift * 0.35, `the largest step is ${Math.max(...steps(values))}px`)
    assert.ok(values.some(value => value > -shift * 0.9 && value < -shift * 0.1), "it passes through the space between")
    assert.equal(values.at(-1), 0)
    assert.equal(await page.locator("[data-id='1']").evaluate(element => element.style.translate), "")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("a removed item folds away and its neighbors close the gap smoothly", async () => {
    const { context, page } = await open()
    const values = await trace(page, {
      click: "[data-test=remove]",
      target: "[data-id='2']",
      read: element => [Number.parseFloat(getComputedStyle(element).translate.split(" ")[1] ?? "0") || 0, document.querySelectorAll("[data-test=list] [data-motion-ghost]").length],
    })
    const shifts = values.map(([value]) => value)
    assert.ok(shifts[0] > 40, `the row below starts where it was (${shifts[0]}px)`)
    assert.ok(Math.max(...steps(shifts)) < shifts[0] * 0.35, `the largest step is ${Math.max(...steps(shifts))}px`)
    assert.equal(shifts.at(-1), 0)
    assert.equal(values[1][1], 1, "the removed row folds away as a copy")
    assert.equal(values.at(-1)[1], 0, "the copy is gone at the end")
    await context.close()
  })

  test("a duplicate grows from the row that it copies", async () => {
    const { context, page } = await open()
    const values = await trace(page, {
      click: "[data-test=duplicate-0]",
      target: "[data-id='4']",
      read: (element) => {
        const own = element.getBoundingClientRect()
        const origin = document.querySelector("[data-id='0']").getBoundingClientRect()
        return [own.top + own.height / 2 - (origin.top + origin.height / 2), Number(getComputedStyle(element).opacity)]
      },
    })
    const [startOffset, startOpacity] = values[0]
    const [endOffset, endOpacity] = values.at(-1)
    assert.ok(startOffset < 4, `it starts on the row it copies (${startOffset}px away)`)
    assert.ok(startOpacity < 0.2, `it starts hidden behind it (${startOpacity})`)
    assert.ok(endOffset > 40, `it ends in its own slot (${endOffset}px below)`)
    assert.equal(endOpacity, 1)
    await context.close()
  })

  test("reduced motion moves nothing and only cross-fades a new item", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.reduce(true))
    const neighbor = await trace(page, { click: "[data-test=add]", target: "[data-id='1']", frames: 30, read: translateY })
    assert.deepEqual([...new Set(neighbor)], [0])
    const added = await trace(page, {
      click: "[data-test=add]",
      target: "[data-id='5']",
      frames: 30,
      read: element => [getComputedStyle(element).scale, getComputedStyle(element).translate, Number(getComputedStyle(element).opacity)],
    })
    assert.deepEqual([...new Set(added.map(([scale, translate]) => `${scale} ${translate}`))], ["none none"])
    assert.ok(added[0][2] < 0.3 && added.at(-1)[2] === 1, "the new item cross-fades")
    await context.close()
  })

  test("data-motion=none turns it off", async () => {
    const { context, page } = await open()
    const values = await trace(page, {
      click: "[data-test=off-add]",
      target: "[data-test=off-list] li:nth-child(2)",
      frames: 20,
      read: element => `${getComputedStyle(element).translate} ${getComputedStyle(element).opacity}`,
    })
    assert.deepEqual([...new Set(values)], ["none 1"])
    await context.close()
  })
})

function fillBox(page) {
  return page.locator("[data-test=progress] [data-part=fill]").evaluate((path) => {
    if (!path.getAttribute("d")) return { height: 0, width: 0 }
    const box = path.getBBox()
    return { height: box.height, width: box.width }
  })
}

describe("Progress", () => {
  test("a head on the bar while it fills, a wave while it processes, and a check that draws at done", async () => {
    const { context, errors, page } = await open()
    const bar = page.locator("[data-test=progress]")
    assert.equal(await bar.getAttribute("role"), "progressbar")
    const width = await bar.locator("[data-part=bar]").evaluate(element => element.clientWidth)

    await page.evaluate(() => window.progress.set(0.4))
    await page.waitForTimeout(600)
    assert.equal(await bar.getAttribute("aria-valuenow"), "40")
    assert.equal(await bar.getAttribute("data-phase"), "fill")
    const filling = await fillBox(page)
    assert.ok(filling.height > 6, `the head makes the bar thicker at its end (${filling.height}px)`)
    assert.ok(Math.abs(filling.width - width * 0.4) < 12, `the bar fills 40% (${filling.width} of ${width})`)

    await page.evaluate(() => window.progress.set(null))
    await page.waitForTimeout(300)
    assert.equal(await bar.getAttribute("aria-valuenow"), null)
    assert.equal(await bar.getAttribute("data-phase"), "wave")
    const waves = await page.evaluate(async () => {
      const path = document.querySelector("[data-test=progress] [data-part=fill]")
      const shapes = []
      for (let index = 0; index < 10; index++) {
        shapes.push(path.getAttribute("d"))
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      return new Set(shapes).size
    })
    assert.ok(waves > 5, `the wave moves on each frame (${waves} shapes in 10 frames)`)

    const check = await page.evaluate(async () => {
      window.progress.done()
      const tick = document.querySelector("[data-test=progress] [data-part=check] path")
      const dot = document.querySelector("[data-test=progress] [data-part=check] circle")
      const frames = []
      for (let index = 0; index < 120; index++) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        frames.push([Number(tick.getAttribute("stroke-dashoffset")), Number(dot.getAttribute("r"))])
      }
      return frames
    })
    const offsets = check.map(([offset]) => offset)
    assert.equal(offsets.at(-1), 0, "the check is drawn")
    assert.ok(offsets.some(offset => offset > 0.1 && offset < 0.9), "the check draws over several frames")
    assert.ok(Math.max(...check.map(([, radius]) => radius)) > 3, "a dot grows first")
    assert.equal(await bar.getAttribute("aria-valuenow"), "100")
    const done = await fillBox(page)
    assert.ok(done.height < 4.5 && Math.abs(done.width - (width - 4)) < 6, `the bar is full and flat (${done.width}×${done.height})`)
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("reduced motion: no head, no wave, and the check cross-fades", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.reduce(true))
    await page.evaluate(() => window.progress.set(0.5))
    await page.waitForTimeout(100)
    assert.ok((await fillBox(page)).height < 4.5, "no head")
    await page.evaluate(() => window.progress.set(null))
    const shapes = await page.evaluate(async () => {
      const path = document.querySelector("[data-test=progress] [data-part=fill]")
      const list = []
      for (let index = 0; index < 10; index++) {
        list.push(path.getAttribute("d"))
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
      return new Set(list).size
    })
    assert.equal(shapes, 1, "no wave")
    await page.evaluate(() => window.progress.done())
    await page.waitForTimeout(400)
    const [offset, radius] = await page.locator("[data-test=progress] [data-part=check]").evaluate(svg => [svg.querySelector("path").getAttribute("stroke-dashoffset"), svg.querySelector("circle").getAttribute("r")])
    assert.equal(offset, "0")
    assert.equal(radius, "0")
    await context.close()
  })
})

function dragOver(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const field = document.querySelector("[data-test=drop]")
    const box = field.getBoundingClientRect()
    const data = new DataTransfer()
    data.items.add(new File(["x"], "cover.png", { type: "image/png" }))
    const at = { x, y }
    const send = type => field.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: box.left + at.x, clientY: box.top + at.y, dataTransfer: data }))
    send("dragenter")
    send("dragover")
    const timer = setInterval(() => send("dragover"), 50)
    window.moveDrag = (nextX, nextY) => Object.assign(at, { x: nextX, y: nextY })
    window.endDrag = (type) => {
      clearInterval(timer)
      send(type)
    }
  }, { x, y })
}

function ink(page, box) {
  return page.locator("[data-test=drop] canvas").evaluate((canvas, { x, y, size }) => {
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext("2d").getImageData(Math.round((x - size) * ratio), Math.round((y - size) * ratio), Math.round(2 * size * ratio), Math.round(2 * size * ratio))
    let total = 0
    let sumX = 0
    for (let index = 3; index < data.data.length; index += 4) {
      const alpha = data.data[index]
      const column = ((index - 3) / 4) % data.width
      total += alpha
      sumX += alpha * column
    }
    return { total, x: x - size + (total ? sumX / total : 0) / ratio }
  }, box)
}

describe("DropField", () => {
  test("the dots lean toward the dragged file and rest after it leaves or drops", async () => {
    const { context, errors, page } = await open()
    const field = page.locator("[data-test=drop]")
    const near = { x: 101, y: 101, size: 10 }
    const lean = { x: 66, y: 94, size: 6 }
    const restNear = await ink(page, near)
    const restLean = await ink(page, lean)

    await dragOver(page, 101, 101)
    await page.waitForTimeout(700)
    assert.equal(await field.getAttribute("data-over"), "")
    assert.equal(await field.locator("[data-slot=drop-field-label]").textContent(), "Release to upload")
    const overNear = await ink(page, near)
    const overLean = await ink(page, lean)
    assert.ok(overNear.total > restNear.total * 3, `the dots near the file get stronger (${restNear.total} to ${overNear.total})`)
    assert.ok(overLean.x - restLean.x > 0.5, `a dot leans toward the file (${restLean.x} to ${overLean.x})`)

    await page.evaluate(() => window.endDrag("dragleave"))
    await page.waitForTimeout(1200)
    assert.equal(await field.getAttribute("data-over"), null)
    const after = await ink(page, near)
    assert.ok(Math.abs(after.total - restNear.total) < restNear.total * 0.2, `the dots rest again (${after.total}, at rest ${restNear.total})`)

    await dragOver(page, 200, 100)
    await page.waitForTimeout(300)
    await page.evaluate(() => window.endDrag("drop"))
    await page.waitForTimeout(1200)
    assert.equal(await page.locator("[data-test=dropped]").textContent(), "cover.png")
    assert.equal(await field.getAttribute("data-over"), null)
    const dropped = await ink(page, { x: 199, y: 101, size: 10 })
    const rest = await ink(page, { x: 199, y: 101 + 14 * 6, size: 10 })
    assert.ok(Math.abs(dropped.total - rest.total) < rest.total * 0.3, "the dots rest after the drop")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("the file input stays for a click and the keyboard", async () => {
    const { context, page } = await open()
    const input = page.locator("[data-test=drop] input[type=file]")
    assert.equal(await input.count(), 1)
    await input.focus()
    assert.equal(await page.evaluate(() => document.activeElement?.type), "file")
    const chooser = page.waitForEvent("filechooser")
    await page.locator("[data-test=drop]").click()
    await chooser
    await context.close()
  })

  test("reduced motion keeps the dots still", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.reduce(true))
    const near = { x: 101, y: 101, size: 10 }
    const rest = await ink(page, near)
    await dragOver(page, 101, 101)
    await page.waitForTimeout(500)
    const over = await ink(page, near)
    await page.evaluate(() => window.endDrag("dragleave"))
    assert.equal(over.total, rest.total)
    await context.close()
  })
})

async function holdButton(page, ms) {
  const box = await page.locator("[data-test=hold]").boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(ms)
  await page.mouse.up()
}

describe("HoldToDelete", () => {
  test("an early release cancels, a full hold removes, Undo restores, and the delete commits once", async () => {
    const { context, errors, page } = await open()
    const hold = page.locator("[data-test=hold]")
    const card = page.locator("[data-test=card]:not([inert])")
    assert.equal(await hold.textContent(), "Hold to delete")

    await holdButton(page, 500)
    const partway = await hold.evaluate(element => Number(element.style.getPropertyValue("--vh-hold")))
    assert.ok(partway > 0.1, `the fill grows while held (${partway})`)
    await page.waitForFunction(() => {
      const element = document.querySelector("[data-test=hold]")
      return element.dataset.state === "idle" && element.style.getPropertyValue("--vh-hold") === "0.0000"
    }, undefined, { timeout: 5000 })
    assert.equal(await card.evaluate(element => element.style.visibility), "")

    const box = await hold.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForFunction(() => document.querySelector("[data-test=hold]").dataset.state === "leaving", undefined, { timeout: 3000 })
    await page.mouse.up()
    await page.waitForFunction(() => [...document.querySelectorAll("[data-test=hold] [data-part=text] > span")].some(letter => getComputedStyle(letter).translate !== "none"), undefined, { timeout: 5000 })
    assert.equal(await card.evaluate(element => element.style.visibility), "hidden")
    await page.waitForFunction(() => document.querySelector("[data-test=hold]").dataset.state === "undo", undefined, { timeout: 3000 })
    assert.equal(await hold.locator("[data-part=text]").textContent(), "Undo")
    assert.equal(await page.locator("[data-test=commits]").textContent(), "0")

    await hold.click()
    assert.equal(await hold.getAttribute("data-state"), "idle")
    assert.equal(await card.evaluate(element => element.style.visibility), "")
    await page.waitForTimeout(1800)
    assert.equal(await page.locator("[data-test=commits]").textContent(), "0", "Undo cancels the delete")

    await holdButton(page, 1400)
    await page.waitForFunction(() => document.querySelector("[data-test=hold]").dataset.state === "undo", undefined, { timeout: 3000 })
    await page.waitForFunction(() => document.querySelector("[data-test=commits]").textContent === "1", undefined, { timeout: 3000 })
    await page.waitForTimeout(2000)
    assert.equal(await page.locator("[data-test=commits]").textContent(), "1", "the delete commits once")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("Space held on the button holds it", async () => {
    const { context, page } = await open()
    const hold = page.locator("[data-test=hold]")
    await hold.focus()
    await page.keyboard.down("Space")
    await page.waitForFunction(() => document.querySelector("[data-test=hold]").dataset.state !== "holding" && document.querySelector("[data-test=hold]").dataset.state !== "idle", undefined, { timeout: 3000 })
    await page.keyboard.up("Space")
    await page.waitForFunction(() => document.querySelector("[data-test=hold]").dataset.state === "undo", undefined, { timeout: 3000 })
    await page.keyboard.press("Enter")
    assert.equal(await hold.getAttribute("data-state"), "idle")
    await context.close()
  })

  test("reduced motion: the letters and the card do not travel", async () => {
    const { context, page } = await open()
    await page.evaluate(() => window.reduce(true))
    const hold = page.locator("[data-test=hold]")
    await holdButton(page, 1300)
    assert.equal(await hold.getAttribute("data-state"), "undo")
    const moved = await hold.evaluate(element => [...element.querySelectorAll("[data-part=text] > span, [data-part=lid]")].some(node => getComputedStyle(node).translate !== "none" || getComputedStyle(node).rotate !== "none"))
    assert.equal(moved, false)
    assert.equal(await page.evaluate(() => document.querySelectorAll("body > [aria-hidden=true][inert]").length), 0, "no copy of the card flies")
    await context.close()
  })
})

const recordDir = process.env.MOTION_RECORD
if (recordDir) {
  test("record each effect at ¼×", { timeout: 900_000 }, async () => {
    mkdirSync(recordDir, { recursive: true })
    const prototype = process.env.MOTION_PROTOTYPE && pathToFileURL(process.env.MOTION_PROTOTYPE).href
    const click = selector => async page => page.locator(selector).click()
    const subjects = [
      { name: "list-insert-remove", clip: "[data-test=list-row]", seconds: 7, act: async (page) => {
        await page.locator("[data-test=add]").click()
        await page.waitForTimeout(2800)
        await page.locator("[data-test=remove]").click()
      } },
      { name: "duplicate", clip: "[data-test=list-row]", seconds: 6, act: async (page) => {
        await page.locator("[data-test=duplicate-0]").click()
        await page.waitForTimeout(1200)
        await page.locator("[data-test=duplicate-0]").click()
      } },
      { name: "progress", clip: "[data-test=progress-row]", seconds: 26, act: click("[data-test=run]") },
      { name: "drop-field", clip: "[data-test=drop]", seconds: 9, act: async (page) => {
        await dragOver(page, 40, 160)
        for (let step = 0; step <= 20; step++) {
          await page.evaluate(({ x, y }) => window.moveDrag(x, y), { x: 40 + step * 12, y: 160 - step * 5 })
          await page.waitForTimeout(100)
        }
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.endDrag("dragleave"))
      } },
      { name: "hold-to-delete", clip: "[data-test=hold-row]", seconds: 16, act: async (page) => {
        await holdButton(page, 4800)
        await page.waitForTimeout(7000)
        await page.locator("[data-test=hold]").click()
      } },
      { name: "uploads-today", query: "?uploads=today", clip: "[data-test=uploads]", seconds: 18, act: click("[data-test=run-uploads]") },
      { name: "uploads-new", query: "?uploads=new", clip: "[data-test=uploads]", seconds: 22, act: click("[data-test=run-uploads]") },
    ]
    if (prototype) {
      const section = id => `#${id}`
      subjects.push(
        { name: "prototype-duplicate", url: prototype, clip: section("v-duplicate"), seconds: 6, act: async (page) => {
          for (let index = 0; index < 3; index++) {
            await page.locator("#v-duplicate-btn").click()
            await page.waitForTimeout(400)
          }
        } },
        { name: "prototype-progress", url: prototype, clip: section("v-progress"), seconds: 26, act: click("#v-progress-act") },
        { name: "prototype-drop-field", url: prototype, clip: section("v-dropzone"), seconds: 9, act: async (page) => {
          const chip = await page.locator("#v-dropzone-chip").boundingBox()
          const zone = await page.locator("#v-dropzone-zone").boundingBox()
          await page.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2)
          await page.mouse.down()
          await page.mouse.move(zone.x + 40, zone.y + 160, { steps: 10 })
          for (let step = 0; step <= 20; step++) {
            await page.mouse.move(zone.x + 40 + step * 12, zone.y + 160 - step * 5)
            await page.waitForTimeout(100)
          }
          await page.waitForTimeout(1500)
          await page.mouse.move(zone.x + zone.width + 60, zone.y + zone.height + 40, { steps: 10 })
          await page.mouse.up()
        } },
        { name: "prototype-hold-to-delete", url: prototype, clip: section("v-hold"), seconds: 16, act: async (page) => {
          const box = await page.locator("#v-hold-btn").boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
          await page.waitForTimeout(4800)
          await page.mouse.up()
          await page.waitForTimeout(7000)
          await page.locator("#v-hold-btn").click()
        } },
      )
    }
    const only = process.env.MOTION_ONLY?.split(",")
    const warm = await open()
    await warm.context.close()
    const summary = {}
    for (const subject of subjects) {
      if (only && !only.includes(subject.name)) continue
      summary[subject.name] = await record(subject)
    }
    writeFileSync(join(recordDir, "lists-summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  })
}

async function record({ name, query = "", url, clip, seconds, act }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  if (url) {
    await page.goto(url)
    await page.locator(clip).evaluate((section) => {
      section.querySelector("[data-k=mode] [data-v=tactile]").click()
      section.querySelector("[data-k=speed] [data-v=slow]").click()
    })
  }
  else {
    await page.goto(`${base}lists.html${query}`)
    await page.waitForFunction(() => window.ready, undefined, { timeout: 60_000 })
    await page.locator("[data-test=speed]").click()
  }
  const element = page.locator(clip)
  await element.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(600)
  const box = await element.boundingBox()
  const pad = 12
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
  const started = Date.now()
  await act(page)
  await page.waitForTimeout(Math.max(500, seconds * 1000 - (Date.now() - started)))
  const end = Date.now() / 1000
  await cdp.send("Page.stopScreencast")
  await context.close()

  const first = Buffer.from(frames[0].data, "base64")
  const ratio = first.readUInt32BE(16) / viewport.width
  const crop = `crop=${Math.round((box.width + 2 * pad) * ratio)}:${Math.round((box.height + 2 * pad) * ratio)}:${Math.max(0, Math.round((box.x - pad) * ratio))}:${Math.max(0, Math.round((box.y - pad) * ratio))}`
  let list = ""
  frames.forEach((frame, index) => {
    writeFileSync(join(dir, `${index}.png`), Buffer.from(frame.data, "base64"))
    list += `file '${index}.png'\nduration ${((frames[index + 1]?.at ?? end) - frame.at).toFixed(4)}\n`
  })
  writeFileSync(join(dir, "frames.txt"), `${list}file '${frames.length - 1}.png'\n`)
  const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args])
  ffmpeg("-f", "concat", "-i", join(dir, "frames.txt"), "-vf", `${crop},scale='min(1200,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,fps=30,format=yuv420p`, "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", "-an", join(recordDir, `${name}.mp4`))
  ffmpeg("-i", join(recordDir, `${name}.mp4`), "-vf", `fps=24/${seconds},scale='min(600,iw)':-2,tile=6x4:padding=4:color=white`, "-frames:v", "1", join(recordDir, `${name}.png`))
  return { frames: frames.length }
}
