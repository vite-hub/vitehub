import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { standaloneUI } from "../../src/standalone/vite.ts"

const root = fileURLToPath(new URL("./comment-send/", import.meta.url))
const screenshots = process.env.COMMENT_SEND_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

const server = await createServer({ configFile: false, logLevel: "warn", optimizeDeps: { noDiscovery: true }, plugins: [standaloneUI(), vue()], resolve: { dedupe: ["vue"] }, root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const base = server.resolvedUrls.local[0]
after(() => server.close())

const browser = await chromium.launch()
after(() => browser.close())

const texts = {
  idle: "Send2",
  pairing: "Setup prompt copied. Paste it in the T3 thread that should get your comments",
  confirm: "T3 Code · relay.t3.codes wants your comments from this siteAllow and send 2",
  sending: "Sending",
  sent: "Sent",
  working: "WorkingOpen thread",
  more: "WorkingOpen threadSend1",
  failed: "Not deliveredRetry",
  limited: "Limit reached, try at 15:10",
  expired: "Setup code expiredCopy again",
  refused: "That URL isn't relay.t3.codesCopy again",
  inbox: "To inbox3",
  claude: "Claude Code · example.com wants your comments from this siteAllow and send 3",
  codex: "Codex · example.com wants your comments from this siteAllow and send 3",
}

async function open(query, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1240, height: 420 }, deviceScaleFactor: 2, locale: "en-GB", timezoneId: "Europe/Madrid", ...options })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${base}?${query}`)
  await page.locator("[data-slot=comment-send]").first().waitFor({ state: "attached", timeout: 120_000 })
  await page.evaluate(() => document.fonts.ready)
  return { page, errors, close: () => context.close() }
}

async function measure(page) {
  return page.evaluate(() => {
    const pill = document.querySelector("vitehub-pill")?.shadowRoot?.querySelector("[role=toolbar]") ?? document.querySelector(".app-pill")
    const segment = document.querySelector("vitehub-tool")?.shadowRoot?.querySelector("[data-slot=comment-send]") ?? document.querySelector("[data-slot=comment-send]")
    const rows = new Set([...segment.querySelectorAll("[data-slot=comment-send-content] > *")].map(item => Math.round(item.getBoundingClientRect().top)))
    const visible = segment.cloneNode(true)
    for (const copy of visible.querySelectorAll("[data-slot=comment-send-hold-copy]")) copy.remove()
    return { text: visible.textContent, state: segment.dataset.state, pill: pill.getBoundingClientRect().height, rows: rows.size, width: segment.getBoundingClientRect().width }
  })
}

for (const surface of ["vitehub", "app"]) {
  describe(`CommentSend in the ${surface} pill`, () => {
    for (const [state, text] of Object.entries(texts)) {
      test(`renders ${state} in one row`, async () => {
        const { page, errors, close } = await open(`surface=${surface}&state=${state}`, { reducedMotion: "reduce" })
        const shown = await measure(page)
        assert.equal(shown.text, text)
        assert.equal(shown.rows, 1, "the segment stays one row")
        assert.ok(shown.pill <= 38, `the pill stays one 28px row (${shown.pill}px)`)
        if (screenshots) await page.screenshot({ path: join(screenshots, `${surface}-${state}.png`), clip: { x: 0, y: 300, width: 1240, height: 120 } })
        assert.deepEqual(errors, [])
        await close()
      })
    }
  })
}

test("the live flow pairs in place, allows once, and keeps the width of Send while it sends", async () => {
  const { page, errors, close } = await open("surface=vitehub&live", { reducedMotion: "reduce" })
  const segment = page.locator("vitehub-tool [data-slot=comment-send]")
  await segment.locator("[data-action=send]").waitFor()
  const sendWidth = await segment.locator("[data-action=send]").evaluate(button => button.getBoundingClientRect().width)

  await segment.locator("[data-action=send]").click()
  await page.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot.querySelector("[data-slot=comment-send]").dataset.state === "pairing")
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Connect this site's comments to this T3 thread/)

  await page.evaluate(() => window.flow.paste())
  await segment.locator("[data-action=allow]").waitFor()
  await segment.locator("[data-action=allow]").click()
  await page.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot.querySelector("[data-slot=comment-send]").dataset.state === "sending")
  const sending = await segment.locator("[data-slot=comment-send-hold]").evaluate(hold => hold.getBoundingClientRect().width)
  assert.ok(Math.abs(sending - sendWidth) < 0.5, `Sending is ${sending}px, Send 2 was ${sendWidth}px`)

  await page.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot.querySelector("[data-slot=comment-send]").dataset.state === "sent")
  await page.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot.querySelector("[data-slot=comment-send]").dataset.state === "working", undefined, { timeout: 5000 })
  assert.equal(await segment.locator("a[data-action=open]").getAttribute("href"), "https://app.t3.codes/threads/42")

  await page.evaluate(() => window.flow.done())
  await page.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot.querySelector("[data-slot=comment-send]").hidden)
  assert.deepEqual(await page.evaluate(() => window.flow.calls), ["startPairing", "allow K7Q-4MX"])
  assert.deepEqual(errors, [])
  await close()
})

test("Escape cancels pairing and drops the setup code", async () => {
  const { page, close } = await open("surface=app&live")
  await page.locator("[data-action=send]").click()
  await page.waitForFunction(() => document.querySelector("[data-slot=comment-send]").dataset.state === "pairing")
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => document.querySelector("[data-slot=comment-send]").dataset.state === "idle")
  assert.deepEqual(await page.evaluate(() => window.flow.calls), ["startPairing", "cancel K7Q-4MX"])
  await close()
})

for (const surface of ["vitehub", "app"]) {
  test(`${surface}: setup and confirmation controls are reachable at 375px`, async () => {
    const { page, errors, close } = await open(`surface=${surface}&live`, { viewport: { width: 375, height: 420 }, reducedMotion: "reduce" })
    try {
      const segment = page.locator("[data-slot=comment-send]")
      const message = segment.locator("[data-slot=comment-send-message] b")
      await segment.locator("[data-action=send]").click()
      await message.filter({ hasText: "Paste it in the T3 thread" }).scrollIntoViewIfNeeded()
      await segment.getByRole("button", { name: "Cancel connect" }).click({ trial: true })

      await page.evaluate(() => window.flow.paste())
      await message.filter({ hasText: "T3 Code" }).scrollIntoViewIfNeeded()
      await segment.locator("[data-action=allow]").click({ trial: true })
      await segment.getByRole("button", { name: "Don't allow" }).click()
      assert.deepEqual(await page.evaluate(() => window.flow.calls), ["startPairing", "cancel K7Q-4MX"])
      assert.deepEqual(errors, [])
    }
    finally {
      await close()
    }
  })
}
