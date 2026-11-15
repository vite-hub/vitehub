// Runs stored reads in headless Chromium with the real IndexedDB and BroadcastChannel. Pages load from a routed
// localhost origin, so no server listens, and the test answers `/api/projects` when it wants.
// Run: pnpm --filter @vite-hub/device test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { build } from "vite"

const origin = "http://localhost:4873"

const output = await build({
  configFile: false,
  logLevel: "silent",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "__VUE_OPTIONS_API__": "false",
    "__VUE_PROD_DEVTOOLS__": "false",
    "__VUE_PROD_HYDRATION_MISMATCH_DETAILS__": "false",
  },
  build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL("app.ts", import.meta.url)), formats: ["es"], fileName: "app" } },
})
const app = (Array.isArray(output) ? output[0] : output).output.find(chunk => chunk.type === "chunk" && chunk.isEntry).code

/** Resolves once `check` passes. */
async function until(check, timeout = 10_000) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > timeout) throw new Error("The condition did not become true in time.")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * One browser profile. `answer(projects)` lets the held `/api/projects` requests answer, and the next ones answer at
 * once. `hold()` makes the next requests wait again.
 */
async function openBrowser(t, { initScript } = {}) {
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext()
  if (initScript) await context.addInitScript(initScript)
  let projects
  let held = []
  const warnings = []
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url())
    const cors = { "access-control-allow-origin": "*" }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<div id="app"></div><script type="module" src="/app.js"></script>` })
    if (url.pathname === "/sandboxed") return route.fulfill({ contentType: "text/html", body: `<iframe sandbox="allow-scripts" src="/"></iframe>` })
    if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", headers: cors, body: app })
    if (url.pathname === "/api/projects") {
      if (projects !== undefined) return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(projects) })
      held.push(route)
      return
    }
    return route.fulfill({ status: 404, body: "" })
  })
  async function open(path = "/") {
    const page = await context.newPage()
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text())
    })
    await page.goto(`${origin}${path}`)
    if (path === "/") await page.waitForFunction(() => window.deviceTest)
    return page
  }
  return {
    open,
    warnings,
    hold() {
      projects = undefined
    },
    async answer(value) {
      projects = value
      const routes = held
      held = []
      await Promise.all(routes.map(route => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(value) }).catch(() => undefined)))
    },
  }
}

const mount = (page, options) => page.evaluate(options => window.deviceTest.mount(options), options)
const text = page => page.evaluate(() => window.deviceTest.text())
const firstRender = page => page.evaluate(() => window.deviceTest.firstRender)
const inspect = page => page.evaluate(() => window.deviceTest.inspectDevice())
const storedKeys = page => page.evaluate(() => window.deviceTest.storedKeys())

/** A first visit as `account` that stores the projects, then a reload with `/api/projects` held. */
async function visitAndReload(profile, { account = "ada", projects = ["p1"], reload = {} } = {}) {
  const page = await profile.open()
  await profile.answer(projects)
  await mount(page, { account })
  await until(async () => (await text(page)) === `${projects.join(",")} success`)
  await until(async () => (await inspect(page)).persisted && (await storedKeys(page)).includes("projects"))
  profile.hold()
  await page.reload()
  await page.waitForFunction(() => window.deviceTest)
  await mount(page, reload)
  return page
}

test("a reload shows the stored copy in the first render, before the loader answers", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await visitAndReload(profile)
  assert.equal(await firstRender(page), "p1 pending stored")
  const opened = await page.evaluate(() => window.deviceTest.openMs)
  await profile.answer(["p1", "p2"])
  await until(async () => (await text(page)) === "p1,p2 success")
  t.diagnostic(`openDevice() with one copy took ${opened.toFixed(1)} ms`)
})

test("another account empties the device, and the screen goes back to the default", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await visitAndReload(profile)
  assert.equal(await text(page), "p1 pending stored")
  const [error] = await page.evaluate(() => window.deviceTest.setDeviceAccount("grace"))
  assert.equal(error, undefined)
  assert.equal(await text(page), "empty pending")
  assert.deepEqual(await storedKeys(page), [])
  assert.deepEqual(await inspect(page), { account: "grace", persisted: true, storage: "indexeddb", entries: [] })
  await page.reload()
  await page.waitForFunction(() => window.deviceTest)
  await mount(page, {})
  assert.equal(await firstRender(page), "empty pending")
})

test("a null account and a page that names no account write nothing", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await profile.open()
  await profile.answer(["p1"])
  await mount(page, {})
  await until(async () => (await text(page)) === "p1 success")
  assert.deepEqual(await inspect(page), { account: null, persisted: false, storage: "indexeddb", entries: [{ key: "projects", storedAt: (await inspect(page)).entries[0].storedAt, bytes: 6 }] })
  assert.deepEqual(await storedKeys(page), [])
  await page.evaluate(() => window.deviceTest.setDeviceAccount(null))
  await page.evaluate(() => window.deviceTest.store("settings", { theme: "dark" }))
  assert.deepEqual(await storedKeys(page), [])
  assert.deepEqual((await inspect(page)).entries, [])
  profile.hold()
  await page.reload()
  await page.waitForFunction(() => window.deviceTest)
  await mount(page, {})
  assert.equal(await firstRender(page), "empty pending")
})

test("clearDevice() clears every tab", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const first = await visitAndReload(profile)
  const second = await profile.open()
  await mount(second, { account: "ada" })
  assert.equal(await text(first), "p1 pending stored")
  assert.equal(await text(second), "p1 pending stored")
  const [error] = await second.evaluate(() => window.deviceTest.clearDevice())
  assert.equal(error, undefined)
  await until(async () => (await text(first)) === "empty pending")
  assert.equal(await text(second), "empty pending")
  assert.deepEqual(await storedKeys(first), [])
  assert.deepEqual((await inspect(first)).entries, [])
})

test("a new version empties the device", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await visitAndReload(profile, { reload: { version: "2" } })
  assert.equal(await firstRender(page), "empty pending")
  await until(async () => (await storedKeys(page)).length === 0)
})

test("a stored copy older than maxAge does not show", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await visitAndReload(profile, { reload: { maxAge: 1 } })
  assert.equal(await firstRender(page), "empty pending")
})

test("the device keeps at most 5 MB, deletes the oldest copies first, and opens them in a few milliseconds", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  const page = await profile.open()
  await profile.answer(["p1"])
  await mount(page, { account: "ada" })
  // Six answers of 1,000,002 bytes each as JSON. 5 MB holds five of them.
  for (const key of ["a", "b", "c", "d", "e", "f"]) {
    await page.evaluate(key => window.deviceTest.store(key, key.repeat(1_000_000)), key)
  }
  await until(async () => (await storedKeys(page)).join() === "b,c,d,e,f")
  assert.deepEqual((await inspect(page)).entries.map(entry => entry.key), ["b", "c", "d", "e", "f"])
  await page.evaluate(() => window.deviceTest.store("huge", "x".repeat(6_000_000)))
  assert.ok(profile.warnings.some(warning => warning.startsWith("[vitehub] DEVICE_VALUE_TOO_LARGE")), profile.warnings.join("\n"))
  assert.ok(!(await inspect(page)).entries.some(entry => entry.key === "huge"))
  await page.reload()
  await page.waitForFunction(() => window.deviceTest)
  await mount(page, {})
  const opened = await page.evaluate(() => window.deviceTest.openMs)
  // The answer of `/api/projects` can join them: it has 6 bytes.
  assert.deepEqual((await inspect(page)).entries.map(entry => entry.key).filter(key => key !== "projects"), ["b", "c", "d", "e", "f"])
  t.diagnostic(`openDevice() with 5 MB of copies took ${opened.toFixed(1)} ms`)
})

test("a sandboxed frame, where IndexedDB throws, keeps copies in memory", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t)
  await profile.answer(["p1"])
  const page = await profile.open("/sandboxed")
  const frame = page.frames().find(candidate => candidate !== page.mainFrame())
  await frame.waitForFunction(() => window.deviceTest)
  await frame.evaluate(() => window.deviceTest.mount({ account: "ada" }))
  await until(async () => (await frame.evaluate(() => window.deviceTest.text())) === "p1 success")
  const inspection = await frame.evaluate(() => window.deviceTest.inspectDevice())
  assert.deepEqual({ ...inspection, entries: inspection.entries.map(entry => entry.key) }, { account: "ada", persisted: false, storage: "memory", entries: ["projects"] })
})

test("an IndexedDB that fails to open, as in some private windows, keeps copies in memory", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t, {
    initScript: () => {
      IDBFactory.prototype.open = function () {
        const request = { onerror: null, onsuccess: null, onupgradeneeded: null, error: new DOMException("A mutation operation was attempted on a database that did not allow mutations.", "InvalidStateError") }
        setTimeout(() => request.onerror?.(new Event("error")))
        return request
      }
    },
  })
  const page = await profile.open()
  await profile.answer(["p1"])
  await mount(page, { account: "ada" })
  await until(async () => (await text(page)) === "p1 success")
  assert.deepEqual((await inspect(page)).storage, "memory")
})

test("an IndexedDB that never answers does not stop the app for more than 1 second", { timeout: 120_000 }, async (t) => {
  const profile = await openBrowser(t, {
    initScript: () => {
      IDBFactory.prototype.open = () => ({})
    },
  })
  const page = await profile.open()
  await profile.answer(["p1"])
  await mount(page, { account: "ada" })
  const opened = await page.evaluate(() => window.deviceTest.openMs)
  assert.ok(opened >= 990 && opened < 1500, `openDevice() took ${opened} ms`)
  await until(async () => (await text(page)) === "p1 success")
  assert.equal((await inspect(page)).storage, "memory")
})
