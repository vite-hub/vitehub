// What Comark UI needs from the motion layer, in Chromium: two copies of the layer on one page, as an app and a document
// that Comark UI renders load them, the `travel` helper, and a divider whose line is a child beside its grip. The copies are the source of `@vite-hub/ui/motion` copied to two folders, so each has
// its own registry, listeners, and springs, as two bundles do.
// Run: pnpm --filter @vite-hub/ui test:motion
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const source = fileURLToPath(new URL("../../src/", import.meta.url))
const root = mkdtempSync(join(tmpdir(), "motion-copies-"))
for (const copy of ["a", "b"]) {
  cpSync(join(source, "motion"), join(root, copy, "motion"), { recursive: true })
  cpSync(join(source, "motion.ts"), join(root, copy, "motion.ts"))
  cpSync(join(source, "motion-core.ts"), join(root, copy, "motion-core.ts"))
  // The hold to delete helper speaks its Undo through the announcer of the package.
  cpSync(join(source, "internal", "announce.ts"), join(root, copy, "internal", "announce.ts"))
}
writeFileSync(join(root, "index.html"), `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 14px system-ui; }
  [role=tablist] { position: relative; display: flex; gap: 8px; padding: 8px; }
  [role=tab] { position: relative; padding: 6px 12px; border: 0; background: none; }
  [data-motion-indicator] { position: absolute; inset: 0; z-index: -1; border-radius: 6px; background: #ddd; visibility: hidden; }
  [aria-selected=true] > [data-motion-indicator] { visibility: visible; }
  #frame { position: fixed; left: 400px; top: 200px; width: 400px; height: 300px; background: #888; transform: scale(1.5); }
</style>
<button id="press" style="height:40px;padding:0 16px">Press</button>
<div role="tablist" id="tabs">
  <button role="tab" aria-selected="true">One<span data-motion-indicator></span></button>
  <button role="tab" aria-selected="false">Two<span data-motion-indicator></span></button>
</div>
<div id="frame"></div>
<div id="pair" style="position:fixed;left:100px;top:560px;width:400px;height:200px;background:#eee">
  <div id="split" role="separator" aria-orientation="vertical" tabindex="0" style="position:absolute;left:0;top:0;bottom:0;width:0;cursor:ew-resize">
    <span id="line" style="position:absolute;inset:0 auto 0 -1px;width:2px;background:#fff"></span>
    <span id="grip" style="position:absolute;top:50%;left:-16px;width:32px;height:32px;border-radius:50%;background:#fff"></span>
  </div>
</div>
<script type="module">
  import * as a from "./a/motion.ts"
  import * as b from "./b/motion.ts"
  import * as first from "./a/motion-core.ts"
  import * as second from "./b/motion-core.ts"
  window.copies = { a, b }
  window.coreCopies = { first, second }
  window.ready = true
</script>
`)

const server = await createServer({ configFile: false, logLevel: "warn", root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

async function open() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(base)
  await page.waitForFunction(() => window.ready)
  return { context, errors, page }
}

describe("copies of the motion layer", () => {
  test("a second copy gives its install and its effects to the first, so a select moves once", async () => {
    const { context, errors, page } = await open()
    const result = await page.evaluate(async () => {
      const { a, b } = window.copies
      // Each effect of copy b counts its own calls, so a select that both copies ran would count twice.
      let calls = 0
      let pendingCalls = 0
      const removePending = b.defineMotionEffect({ name: "pending-select", selector: "[role=tab]", state: () => { pendingCalls++ } })
      const counter = { name: "count-select", selector: "[role=tab]", state: () => { calls++ } }
      const stopA = a.installMotion()
      b.defineMotionEffect(counter)
      const stopB = b.installMotion(document.querySelector("#tabs"))
      const shadow = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" })
      shadow.innerHTML = '<button role="tab" aria-selected="false">Shadow</button>'
      const stopShadow = b.installMotion(shadow)
      const [one, two] = document.querySelectorAll("[role=tab]")
      one.setAttribute("aria-selected", "false")
      two.setAttribute("aria-selected", "true")
      shadow.firstElementChild.setAttribute("aria-selected", "true")
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      const names = a.listMotionEffects().map(effect => effect.name)
      const ownOfB = b.listMotionEffects().length
      removePending()
      stopA()
      stopShadow()
      one.setAttribute("aria-selected", "true")
      await new Promise(requestAnimationFrame)
      stopB()
      return { calls, pendingCalls, names, ownOfB }
    })
    assert.equal(result.calls, 4, "overlapping roots dispatch once, including after the outer root stops")
    assert.equal(result.pendingCalls, 3, "the disposer removes the handed-off effect, even across another install")
    assert.ok(result.names.includes("count-select"), "the effect that copy b defined runs in copy a")
    assert.equal(result.ownOfB, 0, "copy b keeps no registry of its own")
    assert.deepEqual(errors, [])
    await context.close()
  })

  test("the shared layer tracks each root until its last install stops", async () => {
    const { context, page } = await open()
    const events = await page.evaluate(() => {
      const { first, second } = window.coreCopies
      const tabs = document.querySelector("#tabs")
      const events = []
      const stopDocument = first.installMotion(document, { effects: [] })
      const remove = second.defineMotionEffect({
        name: "watch-tabs",
        selector: "[role=tab]",
        watch(root) {
          const name = root === document ? "document" : root.id
          events.push(`start ${name}`)
          return () => events.push(`stop ${name}`)
        },
      })
      const stopFirst = first.installMotion(tabs, { effects: [] })
      const stopSecond = second.installMotion(tabs, { effects: [] })
      stopFirst()
      stopDocument()
      remove()
      stopSecond()
      return events
    })
    assert.deepEqual(events, ["start document", "start tabs", "stop document", "stop tabs"])
    await context.close()
  })

  test("delegated press effects follow the preference of the copy that defined them", async () => {
    const { context, page } = await open()
    const calls = await page.evaluate(() => {
      const { a, b } = window.copies
      let calls = 0
      b.defineMotionEffect({ name: "press-counter", selector: "#press", press: () => { calls++ } })
      a.installMotion()
      b.installMotion()
      const press = document.querySelector("#press")
      a.forceReducedMotion(true)
      b.forceReducedMotion(false)
      press.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      const first = calls
      a.forceReducedMotion(false)
      b.forceReducedMotion(true)
      press.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      return [first, calls]
    })
    assert.deepEqual(calls, [1, 1])
    await context.close()
  })

  test("a press squashes once when both copies cover the button", async () => {
    const { context, page } = await open()
    await page.evaluate(() => {
      window.copies.a.installMotion()
      window.copies.b.installMotion()
      window.copies.a.setMotionSlowFactor(8)
    })
    const box = await page.locator("#press").boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(400)
    const scale = await page.evaluate(() => getComputedStyle(document.querySelector("#press")).scale)
    await page.mouse.up()
    // A 40px button squashes by 3%: once is 0.97, twice from two copies would write over each other or go further.
    const value = Number(scale.split(" ")[0])
    assert.ok(value < 0.995 && value > 0.965, `one squash of 3%: ${scale}`)
    await context.close()
  })
})

describe("divider", () => {
  test("a divider whose line is a child hides only the line while it bends, so its grip stays", async () => {
    const { context, errors, page } = await open()
    await page.evaluate(() => {
      window.copies.a.installMotion()
      document.querySelector("#line").style.setProperty("opacity", "0.5", "important")
    })
    const grip = await page.locator("#grip").boundingBox()
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await page.locator("#line").evaluate(line => line.style.opacity), "0.5")
    await page.mouse.down()
    // The divider sits at its limit, the left edge of the pair, so a pull to the left bends its line.
    await page.mouse.move(grip.x - 60, grip.y + grip.height / 2, { steps: 8 })
    await page.waitForTimeout(100)
    const pulled = await page.evaluate(() => ({
      bent: Boolean(document.querySelector("[data-motion=bend]")),
      line: getComputedStyle(document.querySelector("#line")).opacity,
      handle: getComputedStyle(document.querySelector("#split")).opacity,
      grip: getComputedStyle(document.querySelector("#grip")).opacity,
    }))
    await page.mouse.up()
    assert.deepEqual(pulled, { bent: true, line: "0", handle: "1", grip: "1" })
    await page.waitForFunction(() => !document.querySelector("[data-motion=bend]"), null, { timeout: 5000 })
    assert.deepEqual(await page.locator("#line").evaluate(line => [line.style.opacity, line.style.getPropertyPriority("opacity")]), ["0.5", "important"])
    assert.deepEqual(errors, [])
    await context.close()
  })
})

describe("travel", () => {
  test("an element travels from a box to its place on springs, then clears what it wrote", async () => {
    const { context, errors, page } = await open()
    const frames = await page.evaluate(async () => {
      const frame = document.querySelector("#frame")
      const travel = window.copies.a.travel(frame, { from: { left: 10, top: 20, width: 120, height: 90 } })
      const out = []
      const read = () => {
        const box = frame.getBoundingClientRect()
        return { left: Math.round(box.left), width: Math.round(box.width), inline: frame.style.translate }
      }
      out.push(read())
      let done = false
      travel.done.then(landed => { done = landed })
      for (let index = 0; index < 120 && !done; index++) {
        await new Promise(requestAnimationFrame)
        out.push(read())
      }
      out.push({ ...read(), done })
      return out
    })
    assert.deepEqual(frames[0], { left: 10, width: 120, inline: frames[0].inline }, "it starts on the box it came from")
    assert.ok(frames.some(frame => frame.width > 150 && frame.width < 550), "it grows through the sizes between")
    const last = frames.at(-1)
    // The frame is 400px wide, scaled 1.5 around its center: 600px from 300px.
    assert.deepEqual(last, { left: 300, width: 600, inline: "", done: true }, "it lands at its place and clears the styles")
    assert.deepEqual(errors, [])
    await context.close()
  })

  for (const explicit of [true, false]) test(`retargeting after layout changes keeps position and speed (explicit from: ${explicit})`, async () => {
    const { context, page } = await open()
    const result = await page.evaluate(async (explicit) => {
      const frame = document.querySelector("#frame")
      window.copies.a.setMotionSlowFactor(2)
      const { travel } = window.copies.a
      travel(frame, { from: { left: 10, top: 20, width: 120, height: 90 } })
      for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame)
      const before = frame.getBoundingClientRect()
      frame.style.left = "600px"
      frame.style.width = "320px"
      const back = travel(frame, { from: explicit ? before : undefined, to: { left: 10, top: 20, width: 120, height: 90 } })
      const start = frame.getBoundingClientRect()
      await new Promise(requestAnimationFrame)
      const next = frame.getBoundingClientRect().left
      const landed = await back.done
      const box = frame.getBoundingClientRect()
      back.stop()
      return { before: before.left, start: Math.round(start.left), startWidth: Math.round(start.width), beforeWidth: Math.round(before.width), next, landed, left: Math.round(box.left), width: Math.round(box.width), cleared: !frame.style.translate && !frame.style.scale }
    }, explicit)
    assert.equal(result.start, Math.round(result.before))
    assert.equal(result.startWidth, result.beforeWidth)
    assert.ok(result.next > result.before, `it still moves the way it went for a frame: ${result.before} then ${result.next}`)
    assert.deepEqual({ landed: result.landed, left: result.left, width: result.width }, { landed: true, left: 10, width: 120 })
    assert.equal(result.cleared, true, "stop clears a travel held at its target")
    await context.close()
  })

  for (const css of ["transform: scale(2, 1.25)", "zoom: 2"]) test(`travel uses viewport boxes under ${css}`, async () => {
    const { context, page } = await open()
    const result = await page.evaluate(async (css) => {
      const frame = document.querySelector("#frame")
      const parent = document.body.appendChild(document.createElement("div"))
      parent.style.cssText = css
      parent.append(frame)
      const from = { left: 10, top: 20, width: 120, height: 90 }
      const to = { left: 35, top: 65, width: 170, height: 125 }
      const read = () => {
        const { left, top, width, height } = frame.getBoundingClientRect()
        return [left, top, width, height].map(Math.round)
      }
      const moving = window.copies.a.travel(frame, { from, to })
      const start = read()
      await moving.done
      return [start, read()]
    }, css)
    assert.deepEqual(result, [[10, 20, 120, 90], [35, 65, 170, 125]])
    await context.close()
  })

  for (const delegated of [true, false]) test(`active travel settles when reduced motion turns on (delegated: ${delegated})`, async () => {
    const { context, page } = await open()
    await page.evaluate(async (delegated) => {
      const { a, b } = window.copies
      if (delegated) {
        a.installMotion()
        b.installMotion()
      }
      b.setMotionSlowFactor(20)
      const frame = document.querySelector("#frame")
      const from = { left: 10, top: 20, width: 120, height: 90 }
      const moving = b.travel(frame, delegated ? { from } : { from, to: { ...from, left: 50 } })
      moving.done.then(landed => { window.landed = landed })
      await new Promise(requestAnimationFrame)
      if (!delegated) b.forceReducedMotion(true)
    }, delegated)
    if (delegated) await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() => window.landed === true, null, { timeout: 1000 })
    const [left, wrote] = await page.locator("#frame").evaluate(frame => [Math.round(frame.getBoundingClientRect().left), Boolean(frame.style.translate)])
    assert.deepEqual([left, wrote], delegated ? [300, false] : [50, true])
    await context.close()
  })

  test("under reduced motion the element is at its place at once", async () => {
    const { context, page } = await open()
    const result = await page.evaluate(async () => {
      const frame = document.querySelector("#frame")
      window.copies.a.forceReducedMotion(true)
      const travel = window.copies.a.travel(frame, { from: { left: 10, top: 20, width: 120, height: 90 } })
      return { landed: await travel.done, left: Math.round(frame.getBoundingClientRect().left), inline: frame.style.translate }
    })
    assert.deepEqual(result, { landed: false, left: 300, inline: "" })
    await context.close()
  })

  test("opting out during a travel clears it without another frame", async () => {
    const { context, page } = await open()
    const result = await page.evaluate(async () => {
      const frame = document.querySelector("#frame")
      const { travel } = window.copies.a
      const from = { left: 10, top: 20, width: 120, height: 90 }
      const active = travel(frame, { from })
      frame.dataset.motion = "none"
      const skipped = travel(frame, { from })
      const atRest = !frame.style.translate && !frame.style.scale
      await new Promise(requestAnimationFrame)
      return { landed: await active.done, skipped: await skipped.done, atRest, noWrite: !frame.style.translate && !frame.style.scale }
    })
    assert.deepEqual(result, { landed: false, skipped: false, atRest: true, noWrite: true })
    await context.close()
  })
})
