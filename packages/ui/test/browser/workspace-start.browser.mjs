import assert from "node:assert/strict"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUi from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("./start-page", import.meta.url))
const dist = fileURLToPath(new URL("../../dist/", import.meta.url))
const server = await createServer({
  cacheDir: join(root, "node_modules/.vite"),
  configFile: false,
  logLevel: "warn",
  plugins: [vue(), nuxtUi({ dts: false })],
  resolve: {
    alias: [
      { find: "@vite-hub/ui/styles.css", replacement: join(dist, "styles.css") },
      { find: /^@vite-hub\/ui\/(.+)$/, replacement: `${dist}$1.js` },
    ],
  },
  root,
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})

test("the start screen of Workspace with Nuxt UI opens without console errors, and a pick opens the example", async () => {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole("button", { name: "Choose example" }).waitFor()
  await page.locator(".vh-ws-start").waitFor()
  await page.waitForTimeout(500)
  assert.deepEqual(errors, [])
  await page.getByRole("button", { name: "Choose example" }).click()
  await page.getByRole("menuitemcheckbox", { name: "Bye" }).click()
  await page.getByRole("button", { name: "Example: Bye" }).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
})
