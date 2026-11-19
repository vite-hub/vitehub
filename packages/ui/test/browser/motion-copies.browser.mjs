// Two copies of the motion layer on one page, as an app and a document that Comark UI renders load them, and the
// `travel` helper, in Chromium. The copies are the source of `@vite-hub/ui/motion` copied to two folders, so each has
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
<script type="module">
  import * as a from "./a/motion.ts"
  import * as b from "./b/motion.ts"
  window.copies = { a, b }
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
      const counter = { name: "count-select", selector: "[role=tab]", state: () => { calls++ } }
      const stopA = a.installMotion()
      b.defineMotionEffect(counter)
      const stopB = b.installMotion()
      const [one, two] = document.querySelectorAll("[role=tab]")
      one.setAttribute("aria-selected", "false")
      two.setAttribute("aria-selected", "true")
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      const names = a.listMotionEffects().map(effect => effect.name)
      const ownOfB = b.listMotionEffects().length
      stopB()
      stopA()
      return { calls, names, ownOfB }
    })
    assert.equal(result.calls, 2, "the old and the new tab each change once")
    assert.ok(result.names.includes("count-select"), "the effect that copy b defined runs in copy a")
    assert.equal(result.ownOfB, 0, "copy b keeps no registry of its own")
    assert.deepEqual(errors, [])
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

  test("a travel to a box in the middle of one keeps the speed, and stays on the box", async () => {
    const { context, page } = await open()
    const result = await page.evaluate(async () => {
      const frame = document.querySelector("#frame")
      const { travel } = window.copies.a
      travel(frame, { from: { left: 10, top: 20, width: 120, height: 90 } })
      for (let index = 0; index < 4; index++) await new Promise(requestAnimationFrame)
      const before = frame.getBoundingClientRect().left
      const back = travel(frame, { to: { left: 10, top: 20, width: 120, height: 90 } })
      await new Promise(requestAnimationFrame)
      const next = frame.getBoundingClientRect().left
      const landed = await back.done
      const box = frame.getBoundingClientRect()
      return { before, next, landed, left: Math.round(box.left), width: Math.round(box.width) }
    })
    assert.ok(result.next > result.before, `it still moves the way it went for a frame: ${result.before} then ${result.next}`)
    assert.deepEqual({ landed: result.landed, left: result.left, width: result.width }, { landed: true, left: 10, width: 120 })
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
})
