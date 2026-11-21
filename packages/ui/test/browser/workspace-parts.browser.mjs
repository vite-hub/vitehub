// Measures the workspace parts in headless Chromium and checks their rects against the approved prototype. The page
// is `workspace-parts/`: it mounts one fixture from `workspace-parts/fixtures/` by name, with the ui-sdk set and the
// fake WebContainer of the ui-sdk page. Each file in `workspace-parts/checks/` adds its tests, so a new part needs a
// fixture and a check file and no change here. The prototype numbers are in `workspace-parts/prototype.mjs`.
//
// Run: pnpm --filter @vite-hub/ui test:workspace-parts
// Set WORKSPACE_PARTS_SCREENSHOTS=<dir> to save a screenshot of each part that a check opens.
import assert from "node:assert/strict"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { after, afterEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { viewport } from "./workspace-parts/prototype.mjs"

const root = fileURLToPath(new URL("./workspace-parts/", import.meta.url))
const fakeWebContainer = fileURLToPath(new URL("./ui-sdk/fake-web-container.ts", import.meta.url))
const webContainerSource = fileURLToPath(new URL("../../../web-container/src/", import.meta.url))
const screenshots = process.env.WORKSPACE_PARTS_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [
    vue(),
    {
      // The parts render their controls through the ui-sdk set, so a Nuxt UI import fails the page, as on the ui-sdk page.
      name: "no-nuxt-ui",
      enforce: "pre",
      resolveId: id => id.startsWith("@nuxt/ui/") ? `\0no-nuxt-ui:${id}` : undefined,
      load: id => id.startsWith("\0no-nuxt-ui:")
        ? `export default { name: "NoNuxtUI", setup() { throw new Error(${JSON.stringify(`A part rendered ${id.slice("\0no-nuxt-ui:".length)}`)}); } };`
        : undefined,
    },
    {
      name: "fake-web-container",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "@vite-hub/web-container") return fakeWebContainer
        if (id === "@vite-hub/web-container/vue") return join(webContainerSource, "vue.ts")
        if (id === "./index.ts" && importer?.startsWith(webContainerSource)) return fakeWebContainer
        return undefined
      },
    },
  ],
  root,
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const browser = await chromium.launch()
const base = server.resolvedUrls.local[0]
after(async () => {
  await browser.close()
  await server.close()
})

/** @type {{ page: import("playwright-core").Page, errors: string[] }[]} */
let opened = []
afterEach(async () => {
  const errors = opened.flatMap(entry => entry.errors)
  await Promise.all(opened.map(entry => entry.page.context().close()))
  opened = []
  assert.deepEqual(errors, [])
})

/**
 * Opens one part at the prototype viewport and waits until it is on screen.
 * @param {string} part The file name in `workspace-parts/fixtures/`, without `.ts`.
 * @param {Record<string, string>} [params] More query parameters for the fixture.
 */
async function open(part, params = {}) {
  const context = await browser.newContext({ viewport: { height: viewport.height, width: viewport.width } })
  const page = await context.newPage()
  const entry = { errors: [], page }
  opened.push(entry)
  // The first error ends the wait, so a broken fixture fails with its message and not with a timeout.
  const failed = new Promise((_, reject) => {
    const fail = (message) => {
      entry.errors.push(message)
      reject(new Error(`${part} failed: ${message}`))
    }
    page.on("pageerror", error => fail(error.message))
    page.on("console", message => message.type() === "error" && fail(message.text()))
  })
  failed.catch(() => {})
  const query = new URLSearchParams({ part, ...params })
  await page.goto(`${base}?${query}`)
  await Promise.race([page.locator("html[data-ready]").waitFor({ state: "attached", timeout: 20_000 }), failed])
  if (screenshots) await page.screenshot({ path: join(screenshots, `${[part, ...Object.values(params)].join("-")}.png`) })
  return page
}

/**
 * The rect of the first element of each selector, rounded to 0.01px, or `undefined` when nothing matches.
 * @param {import("playwright-core").Page} page
 * @param {Record<string, string>} selectors
 */
function rects(page, selectors) {
  return page.evaluate((entries) => Object.fromEntries(entries.map(([name, selector]) => {
    const element = document.querySelector(selector)
    if (!element) return [name, undefined]
    const { x, y, width, height } = element.getBoundingClientRect()
    const round = value => Math.round(value * 100) / 100
    return [name, { x: round(x), y: round(y), w: round(width), h: round(height) }]
  })), Object.entries(selectors))
}

/** Passes when `actual` is within `tolerance` CSS pixels of `expected`. */
function near(actual, expected, label, tolerance = 1) {
  assert.equal(typeof actual, "number", `${label}: no element`)
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not ${expected} (±${tolerance})`)
}

/** @typedef {{ test: typeof test, open: typeof open, rects: typeof rects, near: typeof near }} Harness */
const checks = join(root, "checks")
for (const file of readdirSync(checks).filter(name => name.endsWith(".mjs")).sort()) {
  const { default: register } = await import(pathToFileURL(join(checks, file)).href)
  register({ near, open, rects, test })
}
