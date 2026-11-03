// Mounts the workspace demo page with a real WebContainer in headless Chromium, through the built package.
// It needs network access to StackBlitz and the npm registry.
// Run: pnpm --filter @vite-hub/ui test:browser
// Set WORKSPACE_SCREENSHOTS=<dir> to save screenshots of each state.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { hubWebContainer } from "@vite-hub/web-container/vite"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const port = Number(process.env.WORKSPACE_TEST_PORT ?? 4796)
const root = fileURLToPath(new URL("./page", import.meta.url))
const dist = fileURLToPath(new URL("../../dist/", import.meta.url))
const screenshots = process.env.WORKSPACE_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

async function shot(page, name) {
  if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) })
}

async function waitForFrame(page, origin) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const frame = page.frames().find(candidate => candidate.url().startsWith(origin))
    if (frame) return frame
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`No frame loaded ${origin}`)
}

test("boots the workspace shell with a real WebContainer, edits a file, and shows the preview", { timeout: 8 * 60_000 }, async (t) => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    plugins: [vue(), hubWebContainer({ routes: ["/**"] })],
    resolve: {
      alias: [
        { find: "@vite-hub/ui/styles.css", replacement: join(dist, "styles.css") },
        { find: /^@vite-hub\/ui\/(.+)$/, replacement: `${dist}$1.js` },
      ],
    },
    root,
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  const browser = await chromium.launch({ args: ["--headless=new"] })
  t.after(async () => {
    await browser.close()
    await server.close()
  })
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { height: 760, width: 1360 } })
  const page = await context.newPage()
  page.on("pageerror", error => console.log("[page error]", error.message))
  const base = `http://127.0.0.1:${port}/`

  const started = performance.now()
  await page.goto(base)
  await page.waitForFunction(() => window.workspace)
  // The checklist is on screen while the container installs.
  await page.waitForSelector(".vh-ws-boot [data-state='running']")
  await page.waitForFunction(() => ["installing", "starting"].includes(window.workspace.status.value), undefined, { timeout: 120_000 })
  assert.equal(await page.locator(".vh-ws-step").count(), 5)
  await shot(page, "boot")

  await page.waitForFunction(() => window.workspace.previewUrl.value, undefined, { timeout: 180_000 })
  const previewUrl = await page.evaluate(() => window.workspace.previewUrl.value)
  console.log("ready in", Math.round(performance.now() - started), "ms", previewUrl)
  assert.equal(await page.locator(".vh-ws-overlay").count(), 0, "the overlay closes when the server is ready")

  const frame = await waitForFrame(page, new URL(previewUrl).origin)
  await frame.waitForFunction(() => document.body?.textContent?.includes("Hello from /"), undefined, { timeout: 60_000 })
  // CodeMirror replaced the fallback text, and the tabs are 44px high.
  await page.waitForSelector(".vh-ws-editor .cm-content")
  assert.ok((await page.locator("[role='tab']").first().boundingBox()).height >= 44)

  // Edit through the editor, then restart the server and reload the preview.
  await page.locator(".vh-ws-file-tree").evaluate(element => element.shadowRoot.querySelector("[data-item-path='lib/greeting.js'], [data-item-path='lib/greeting.js/']")?.click())
  await page.waitForFunction(() => document.querySelector(".vh-ws-editor")?.dataset.path === "lib/greeting.js")
  await page.locator(".vh-ws-editor .cm-content").click()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("export function greeting(path) {\n  return `Edited in the browser: ${path}`\n")
  await page.waitForFunction(() => window.workspace.modified.value.includes("lib/greeting.js"))
  const written = await page.evaluate(async () => {
    await window.workspace.setFiles({})
    return window.workspace.fs.value.readFile("lib/greeting.js", "utf-8")
  })
  assert.match(written, /Edited in the browser/)
  await page.evaluate(() => window.workspace.restart())
  await page.waitForFunction(() => window.workspace.previewUrl.value, undefined, { timeout: 60_000 })
  await page.getByRole("button", { name: "Reload preview" }).click()
  const edited = await waitForFrame(page, new URL(previewUrl).origin)
  await edited.waitForFunction(() => document.body?.textContent?.includes("Edited in the browser: /"), undefined, { timeout: 60_000 })
  await shot(page, "ready")

  await page.getByRole("tab", { name: "Terminal" }).click()
  await page.waitForFunction(() => document.querySelector(".vh-ws-terminal .xterm-rows")?.textContent?.includes("listening on 3000"))
  assert.equal(await page.locator("[data-tab='preview']").getAttribute("inert"), "")
  await shot(page, "terminal")
  await page.close()

  // An install that fails shows its exit code, Retry install, and Show output.
  const failing = await context.newPage()
  await failing.goto(`${base}?fail=install`)
  await failing.waitForFunction(() => window.workspace?.failure.value?.kind === "install", undefined, { timeout: 180_000 })
  await failing.getByRole("button", { name: "Retry install" }).waitFor()
  assert.match(await failing.locator(".vh-ws-boot").innerText(), /Install failed/)
  await shot(failing, "error-install")
  await failing.close()

  // The Connect panel and the Safari notice need no container.
  const connect = await context.newPage()
  await connect.setViewportSize({ height: 1100, width: 1360 })
  await connect.goto(`${base}?boot=0&tab=connect`)
  await connect.getByRole("button", { name: "Connect Anthropic" }).click()
  await connect.getByLabel("Anthropic token").fill("sk-ant-demo")
  await shot(connect, "connect")
  await connect.getByRole("button", { name: "Save" }).click()
  assert.deepEqual(await connect.evaluate(() => JSON.parse(sessionStorage.getItem("vitehub:connect"))), { anthropic: "sk-ant-demo" })
  await connect.goto(`${base}?boot=0&notice=safari`)
  await connect.getByRole("button", { name: "Why?" }).click()
  await connect.getByText("Safari does not support the browser isolation").waitFor()
  await shot(connect, "safari-notice")
})
