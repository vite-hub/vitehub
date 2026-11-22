import assert from "node:assert/strict"
import { test } from "node:test"

import { chromium } from "playwright-core"

const base = process.env.DOCS_URL ?? "http://127.0.0.1:4791"

test("workspace pages of the docs playground", { timeout: 10 * 60_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  await t.test("the chooser gives every example its own URL, the first one too", async () => {
    const page = await context.newPage()
    await page.goto(`${base}/docs/try/playground`, { timeout: 180_000 })
    const first = page.locator(".vh-ws-start-grid button").first()
    await first.waitFor({ timeout: 180_000 })
    assert.equal(new URL(page.url()).search, "")
    await first.click()
    await page.waitForURL(/\?example=hello$/, { timeout: 15_000 })
    await page.close()
  })

  await t.test("Reset after Solve restores the start files of the step, and Next does not warn", async () => {
    const page = await context.newPage()
    await page.goto(`${base}/docs/try/first-server`, { timeout: 180_000 })
    await page.getByRole("treeitem").first().waitFor({ timeout: 180_000 })
    const reset = page.getByRole("button", { name: "Reset", exact: true })
    assert.equal(await reset.isDisabled(), true)

    await page.getByRole("button", { name: "Solve" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor()
    assert.equal(await reset.isEnabled(), true)

    await reset.click()
    await page.getByRole("dialog").getByRole("button", { name: "Discard changes" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor({ state: "detached" })
    assert.equal(await reset.isDisabled(), true)

    await page.getByRole("button", { name: "Solve" }).click()
    await page.getByRole("treeitem", { name: "greeting.mjs" }).waitFor()
    await page.getByRole("button", { name: "Next: Add the time" }).click()
    await page.getByText("Step 2 of 2").first().waitFor()
    assert.equal(await page.getByRole("button", { name: "Load step 2" }).count(), 0)
    await page.close()
  })
})
