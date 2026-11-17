// CSS anchor positioning places CommentLayer's thread cards and AgentSession's floating details card. This runs the page
// `anchored/` in Chromium, Firefox, and WebKit, and checks where each card lands against the real card size.
//
// Run: pnpm --filter @vite-hub/ui test:anchored
// It needs the Playwright browsers of the workspace's playwright-core: `pnpm exec playwright-core install chromium firefox webkit`.
// Set ANCHORED_SCREENSHOTS=<dir> to save a screenshot of each case.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium, firefox, webkit } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("./anchored/", import.meta.url))
const screenshots = process.env.ANCHORED_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

const server = await createServer({ configFile: false, logLevel: "warn", plugins: [vue()], root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const base = server.resolvedUrls.local[0]
after(() => server.close())

/** Opens a thread on a pin at `x`, `y`, and returns the box of its spot and of its card. */
async function openThread(page, x, y) {
  return page.evaluate(async ([x, y]) => {
    const spot = document.querySelector("#spot")
    Object.assign(spot.style, { left: `${x}px`, top: `${y}px` })
    window.comments.startDraft(spot, { point: { x, y } })
    window.comments.draft.value.body = "The yearly price should be 190, not 199."
    const thread = await window.comments.send()
    window.comments.open(thread)
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const item = document.querySelector("[data-slot=comment-layer-item]:has(> [data-slot=comment-layer-popover]:not([data-preview]))")
    const card = item.querySelector(":scope > [data-slot=comment-layer-popover]").getBoundingClientRect()
    const at = item.getBoundingClientRect()
    // The side that the corner pointing at the pin follows.
    const flip = ["x", "y"].filter(axis => item.getAttribute(`data-flip-${axis}`) === "true").join("") || "none"
    return { card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom, height: card.height }, flip, spot: { x: at.left, y: at.top } }
  }, [x, y])
}

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1.5, `${label}: ${actual} is not ${expected}`)

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  describe(name, async () => {
    const browser = await type.launch()
    after(() => browser.close())
    const shot = async (page, label) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-${label}.png`) })
    }
    const open = async (view, viewport = { width: 1280, height: 800 }) => {
      const page = await browser.newPage({ viewport })
      const errors = []
      page.on("pageerror", error => errors.push(error.message))
      await page.goto(`${base}?view=${view}`)
      return { page, errors }
    }

    test("the browser supports CSS anchor positioning", async () => {
      const { page } = await open("comments")
      assert.equal(await page.evaluate(() => CSS.supports("anchor-name: --a")), true)
      await page.close()
    })

    test("a thread's card opens under its pin and to the right where it fits, with its small corner at the pin", async () => {
      const { page, errors } = await open("comments")
      await page.waitForFunction(() => window.comments)
      const { card, flip, spot } = await openThread(page, 200, 160)
      near(card.left, spot.x + 8, "left")
      near(card.top, spot.y + 8, "top")
      assert.equal(flip, "none")
      await shot(page, "card-below-right")
      assert.deepEqual(errors, [])
      await page.close()
    })

    test("a card that fits under its pin stays there, though the guessed 420px card would not", async () => {
      const { page } = await open("comments")
      await page.waitForFunction(() => window.comments)
      const { card, flip, spot } = await openThread(page, 200, 500)
      assert.ok(spot.y + 420 > 800, "the spot is where the size guess flips the card")
      assert.ok(card.bottom <= 800 - 8, `the card fits (${card.bottom})`)
      near(card.top, spot.y + 8, "top")
      assert.equal(flip, "none")
      await page.close()
    })

    test("near the right edge, the card opens to the left of its pin", async () => {
      const { page } = await open("comments")
      await page.waitForFunction(() => window.comments)
      const { card, flip, spot } = await openThread(page, 1200, 160)
      near(card.right, spot.x - 8, "right")
      near(card.top, spot.y + 8, "top")
      assert.equal(flip, "x")
      await shot(page, "card-right-edge")
      await page.close()
    })

    test("near the bottom edge, the card opens above its pin", async () => {
      const { page } = await open("comments")
      await page.waitForFunction(() => window.comments)
      const { card, flip, spot } = await openThread(page, 200, 760)
      near(card.left, spot.x + 8, "left")
      near(card.bottom, spot.y - 40, "bottom")
      assert.equal(flip, "y")
      await shot(page, "card-bottom-edge")
      await page.close()
    })

    test("in the bottom right corner, the card opens above its pin and to the left", async () => {
      const { page } = await open("comments")
      await page.waitForFunction(() => window.comments)
      const { card, flip, spot } = await openThread(page, 1200, 760)
      near(card.right, spot.x - 8, "right")
      near(card.bottom, spot.y - 40, "bottom")
      assert.equal(flip, "xy")
      await shot(page, "card-corner")
      await page.close()
    })

    test("on a phone, the card stays inside the screen", async () => {
      const { page } = await open("comments", { width: 375, height: 700 })
      await page.waitForFunction(() => window.comments)
      for (const [x, side] of [[40, "none"], [180, "none"], [340, "x"]]) {
        const { card, flip, spot } = await openThread(page, x, 160)
        assert.ok(card.left >= 8 - 1 && card.right <= 375 - 8 + 1, `x=${x}: ${card.left}, ${card.right}`)
        near(card.top, spot.y + 8, `x=${x} top`)
        assert.equal(flip, side, `x=${x} corner`)
        await page.evaluate(() => window.comments.close())
      }
      await shot(page, "card-phone")
      await page.close()
    })

    test("the session details card floats over the body's top end corner as a native popover", async () => {
      const { page, errors } = await open("session")
      const toggle = page.locator("[data-slot=agent-session-details-toggle]")
      const details = page.locator("[data-slot=agent-session-details]")
      await toggle.click()
      await page.waitForFunction(() => document.querySelector("[data-slot=agent-session-details]")?.matches(":popover-open"))
      assert.equal(await toggle.getAttribute("aria-pressed"), "true")
      const [card, body] = await Promise.all([details.boundingBox(), page.locator("[data-slot=agent-session-body]").boundingBox()])
      near(card.y, body.y, "top")
      near(card.x + card.width, body.x + body.width - 12, "right")
      await shot(page, "session-details")
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector("[data-slot=agent-session-details]").matches(":popover-open"))
      assert.equal(await toggle.getAttribute("aria-pressed"), "false")
      await toggle.click()
      await page.waitForFunction(() => document.querySelector("[data-slot=agent-session-details]").matches(":popover-open"))
      await page.mouse.click(1200, 700)
      await page.waitForFunction(() => !document.querySelector("[data-slot=agent-session-details]").matches(":popover-open"))
      await toggle.click()
      await page.waitForFunction(() => document.querySelector("[data-slot=agent-session-details]").matches(":popover-open"))
      await toggle.click()
      await page.waitForFunction(() => !document.querySelector("[data-slot=agent-session-details]").matches(":popover-open"))
      assert.deepEqual(errors, [])
      await page.close()
    })
  })
}
