// Run from packages/ui: node --test test/browser/console-scope.browser.mjs
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUI from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"
import { vitehubTheme } from "../../src/theme.ts"
import { inlineWebCss, scopeStyles } from "../../../kit/scripts/styles.ts"

// Load the real Console stylesheet, without adding tokens.css to the fixture.
const root = fileURLToPath(new URL("../../../../", import.meta.url))
const kit = new URL("../../../kit/", import.meta.url)
const cache = new URL("node_modules/.cache/console-scope/", kit)
mkdirSync(cache, { recursive: true })
const scoped = new URL("default.scoped.css", cache)
const require = createRequire(new URL("package.json", kit))
writeFileSync(scoped, scopeStyles(inlineWebCss(
  readFileSync(new URL("src/styles/default.css", kit), "utf8"),
  readFileSync(require.resolve("@ui-sdk/core/web.css"), "utf8"),
)))
// ui-sdk puts its own <style> with a \`ui-sdk\` layer first in <head> when a part mounts, such as the Console toaster. The
// style comes before the Console stylesheet, as in the Console.
const html = `<html><head><style id="ui-sdk-popover-reset">@layer ui-sdk { :where([data-slot="toast-region"][popover]) { margin: 0 } }</style>
<script type="module">import '/packages/vite-hub/src/console/runtime/client/styles.css'</script></head>
<body><button id="outside">Nuxt UI host</button><section class="ui-sdk">
<button id="solid" data-slot="button" data-variant="solid">Save changes</button>
<input id="input" data-slot="input" placeholder="Name">
<div id="popup" data-slot="popover-content">Account settings</div>
</section></body></html>`
const server = await createServer({
  configFile: false,
  root,
  logLevel: "warn",
  resolve: { alias: {
    "@vite-hub/ui/theme.css": fileURLToPath(new URL("../../theme.css", import.meta.url)),
    "@vite-hub/kit/styles/default.scoped.css": fileURLToPath(scoped),
    "@vite-hub/kit/styles/tailwind.css": fileURLToPath(new URL("src/styles/tailwind.css", kit)),
  } },
  plugins: [
    { name: "console-scope-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", html))
      })
    } },
    vue(),
    nuxtUI({ autoImport: false, colorMode: false, components: false, dts: false, ui: { colors: vitehubTheme.colors } }),
  ],
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const browser = await chromium.launch()
after(async () => { await browser.close(); await server.close() })

for (const mode of ["light", "dark"]) {
  test(`Console scoped controls have complete tokens in ${mode}`, { timeout: 30_000 }, async () => {
    const page = await browser.newPage({ colorScheme: mode })
    try {
      await page.goto(`${server.resolvedUrls.local[0]}fixture`)
      await page.evaluate(mode => document.documentElement.className = mode, mode)
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#solid')).getPropertyValue('--ui-font-size').trim() === '0.875rem')
      const values = await page.evaluate(() => {
        const style = id => getComputedStyle(document.getElementById(id))
        return {
          color: style("solid").color,
          background: style("solid").backgroundColor,
          input: style("input").borderTopColor,
          inputToken: style("input").getPropertyValue("--ui-input").trim(),
          popup: style("popup").backgroundColor,
          // Preflight sets the padding to 0. The kit's button padding must win.
          padding: style("solid").paddingInlineStart,
          shadow: style("popup").boxShadow,
          outsideRadius: style("outside").getPropertyValue("--ui-radius").trim(),
          outsidePrimary: style("outside").getPropertyValue("--ui-primary").trim(),
          primary: style("outside").getPropertyValue("--primary").trim(),
        }
      })
      assert.notEqual(values.color, values.background)
      assert.ok(values.inputToken)
      assert.notEqual(values.input, "rgba(0, 0, 0, 0)")
      assert.notEqual(values.popup, "rgba(0, 0, 0, 0)")
      assert.notEqual(values.shadow, "none")
      assert.equal(values.padding, "12px")
      assert.equal(values.outsideRadius, "0.25rem")
      assert.equal(values.outsidePrimary, values.primary)
    } finally { await page.close() }
  })
}
