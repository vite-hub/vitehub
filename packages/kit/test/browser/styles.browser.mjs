// Renders every kit part under the default style family in headless Chromium, closed and open, light and dark, at a
// desktop and a phone width. The check fails when a page throws, when a part renders with a `data-slot` that the family
// does not style, or when `[data-theme="dark"]` and `.dark` give different tokens.
//
// Run: pnpm --filter @vite-hub/kit test:styles
// Set STYLES_SCREENSHOTS=<dir> to save a screenshot of each page, and STYLES_TEST_PORT to pick the port.
import assert from "node:assert/strict"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("./page/", import.meta.url))
const styles = fileURLToPath(new URL("../../src/styles/", import.meta.url))
const src = fileURLToPath(new URL("../../src/", import.meta.url))
const screenshots = process.env.STYLES_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

// Elements of the ui-sdk examples, not kit parts: the layout helpers of the ui-sdk docs.
const exampleSlots = new Set(["card", "files", "grid", "grip", "hint", "initials", "row", "stack", "tile"])
// Visible parts that need no rule: groups and list wrappers, whose items carry the look.
const unstyledSlots = new Set([
  "autocomplete-list",
  "collapsible",
  "combobox-list",
  "command-group",
  "menu-group",
  "menu-radio-group",
  "navigation-menu-item",
  // The real input of the code field. ui-sdk lays it over the slots, transparent, with inline styles.
  "otp-input-control",
  "pagination",
  "pagination-item",
])

// Each file in `page/open/` renders one popup open: menus, selects, popovers, tooltips, dialogs, and the drawer.
const openViews = readdirSync(join(root, "open")).map(file => file.replace(/\.vue$/, "")).sort()

const familySlots = new Set([...readFileSync(join(styles, "default.css"), "utf8").matchAll(/data-slot="([a-z-]+)"/g)].map(match => match[1]))

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^@vite-hub\/kit\/styles\/(.+)$/, replacement: `${styles}$1` },
      { find: /^@vite-hub\/kit\/(.+)$/, replacement: `${src}$1.ts` },
    ],
  },
  root,
  server: { host: "127.0.0.1", port: Number(process.env.STYLES_TEST_PORT ?? 0), strictPort: true },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})
const base = server.resolvedUrls.local[0]

async function open(query, { width, theme }) {
  const context = await browser.newContext({ viewport: { height: 900, width }, reducedMotion: "reduce" })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(`${base}?${query}&theme=${theme}`)
  await page.waitForSelector(".fixture > section")
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  return { context, errors, page }
}

async function shot(page, name, fullPage = true) {
  if (screenshots) await page.screenshot({ fullPage, path: join(screenshots, `${name}.png`) })
}

// The slots of the parts a user can see. Native inputs that ui-sdk keeps for forms and screen readers are hidden.
async function renderedSlots(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll("[data-slot]")]
    .filter((element) => {
      const box = element.getBoundingClientRect()
      return box.width > 1 && box.height > 1 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    })
    .map(element => element.dataset.slot))])
}

const widths = [1440, 390]
const themes = ["light", "dark"]
const seen = new Set()

for (const width of widths) {
  for (const theme of themes) {
    test(`every part, closed and open, at ${width}px in ${theme}`, { timeout: 120_000 }, async () => {
      const all = await open("view=all", { width, theme })
      for (const slot of await renderedSlots(all.page)) seen.add(slot)
      await shot(all.page, `all-${width}-${theme}`)
      assert.deepEqual(all.errors, [], "page errors")
      await all.context.close()

      for (const view of openViews) {
        const { context, errors, page } = await open(`view=${view}`, { width, theme })
        await page.waitForSelector(`[data-slot="${view}-content"]:not([hidden])`)
        await page.waitForTimeout(500)
        for (const slot of await renderedSlots(page)) seen.add(slot)
        await shot(page, `open-${view}-${width}-${theme}`, false)
        assert.deepEqual(errors, [], `${view} page errors`)
        await context.close()
      }

      const { context, errors, page } = await open("view=toast", { width, theme })
      await page.locator('[data-part="toast"] button').first().click()
      await page.waitForSelector('[data-slot="toast"]')
      await page.waitForTimeout(500)
      for (const slot of await renderedSlots(page)) seen.add(slot)
      await shot(page, `toast-${width}-${theme}`, false)
      assert.deepEqual(errors, [], "toast page errors")
      await context.close()
    })
  }
}

test("styles every part that renders", () => {
  const missing = [...seen].filter(slot => !familySlots.has(slot) && !exampleSlots.has(slot) && !unstyledSlots.has(slot)).sort()
  assert.deepEqual(missing, [], "parts that render without a rule in src/styles/default.css")
})

test("switches the tokens with .dark and with [data-theme=dark]", async () => {
  const tokens = ["--background", "--foreground", "--popover", "--primary", "--border", "--ring", "--shadow-popover"]
  const read = async theme => {
    const { context, page } = await open("view=button", { width: 800, theme })
    const values = await page.evaluate(names => names.map(name => getComputedStyle(document.documentElement).getPropertyValue(name)), tokens)
    await context.close()
    return values
  }
  const light = await read("light")
  const dark = await read("dark")
  assert.notDeepEqual(dark, light)
  assert.deepEqual(await read("data-dark"), dark)
})
