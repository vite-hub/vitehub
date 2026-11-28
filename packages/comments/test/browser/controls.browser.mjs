import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_CONTROLS_BROWSER_PORT ?? 4792)
const evidence = process.env.COMMENTS_BROWSER_EVIDENCE
const harness = fileURLToPath(new URL("../harness.ts", import.meta.url))
const handlerFile = fileURLToPath(new URL("../../src/runtime/handler.ts", import.meta.url))
const maxi = { id: "u1", name: "Maxi" }

function commentsApi() {
  let comments
  const ready = async (server) => {
    if (comments) return comments
    const { createComments } = await server.ssrLoadModule(harness)
    comments = await createComments({ storeAttachment: file => `files/${file.name}`, readAttachment: () => null })
    for (const body of ["The rental desk part is too long", "Say when to order the cozido"]) await comments.create({ page: "/", body, author: maxi })
    const [, done] = await comments.create({ page: "/", body: "Fix the bus count", author: maxi })
    await comments.resolve(done.id, { by: maxi })
    return comments
  }
  return {
    name: "comments-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/_vitehub/comments/")) return next()
        const [store, { createCommentsHandler }, { H3 }] = await Promise.all([ready(server), server.ssrLoadModule(handlerFile), import("h3")])
        const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments: store, realtime: false, session: async () => maxi }))
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await app.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}

const controls = page => page.evaluate(() => [...document.querySelector("vitehub-tool").shadowRoot.querySelector(".toolbar").querySelectorAll(":scope > .lead > button, :scope > button, :scope > [data-slot]")]
  .map(item => item.dataset.action ?? item.dataset.slot ?? item.getAttribute("aria-label") ?? item.textContent.trim()))

const luminance = color => {
  const [red, green, blue] = color.match(/[\d.]+/g).map(Number)
  return (red + green + blue) / 3
}

test("the pill controls, Shift+C, Copy prompt, and the All comments panel", { timeout: 180_000 }, async (t) => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    optimizeDeps: { noDiscovery: true },
    plugins: [standaloneUI(), commentsApi()],
    resolve: { alias: overlayAliases, dedupe: ["vue"] },
    root: fileURLToPath(new URL("./controls-page", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  t.after(() => server.close())
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 }, deviceScaleFactor: 2 })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` })
  if (evidence) await mkdir(evidence, { recursive: true })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  const tool = page.locator("vitehub-tool")
  const copyButton = tool.locator("[data-action='copy-page-prompt']")
  await copyButton.waitFor({ timeout: 60_000 })
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText())
  const commentMode = () => page.evaluate(() => document.documentElement.classList.contains("vitehub-comment-mode"))
  const shot = async (name) => {
    if (!evidence) return
    await page.waitForTimeout(300)
    await page.locator("vitehub-pill").screenshot({ path: `${evidence}/${name}.png` })
  }
  let prompt

  await t.test("view mode shows Comments, the eye, Copy prompt, and Highlight inline with no +", async () => {
    assert.deepEqual(await controls(page), ["Comments, 2 open", "Hide comments", "copy-page-prompt", "Highlight"])
    assert.equal(await tool.locator("[data-action='more-tools']").count(), 0)
    assert.match(await copyButton.textContent(), /Copy prompt/)
    await copyButton.click()
    prompt = await clipboard()
    assert.match(prompt, /The rental desk part is too long|\/_vitehub|Console/)
    await shot("pill-view")
  })

  await t.test("comment mode shows Click anywhere, the eye, All comments, Copy prompt, and Highlight inline", async () => {
    await page.keyboard.press("c")
    await page.waitForFunction(() => document.documentElement.classList.contains("vitehub-comment-mode"))
    assert.deepEqual(await controls(page), ["Comments: click anywhere on the page", "Hide comments", "All comments2", "copy-page-prompt", "Highlight"])
    await page.evaluate(() => navigator.clipboard.writeText(""))
    await copyButton.click()
    assert.equal(await clipboard(), prompt)
    await shot("pill-comment")
    assert.equal(await tool.locator("[data-action='more-tools']").count(), 0)
  })

  await t.test("Shift+C hides and shows comments with a toast, and plain c still toggles comment mode", async () => {
    const eye = tool.locator("button.eye")
    assert.deepEqual([await eye.getAttribute("title"), await eye.getAttribute("aria-keyshortcuts")], ["Hide comments (Shift+C)", "Shift+C"])
    await page.keyboard.press("Shift+C")
    assert.equal(await commentMode(), true)
    assert.deepEqual([await eye.getAttribute("aria-label"), await eye.getAttribute("title")], ["Show comments", "Show comments (Shift+C)"])
    const toast = page.locator("vitehub-comments .toast")
    await toast.waitFor({ timeout: 5000 })
    assert.equal((await toast.textContent()).trim(), "Comments hidden. Press Shift+C to show them.")
    const fill = await eye.evaluate(button => getComputedStyle(button).backgroundColor)
    assert.ok(luminance(fill) > 200, `the hidden eye is filled: ${fill}`)
    await shot("pill-hidden")
    await page.keyboard.press("Shift+C")
    assert.equal(await eye.getAttribute("aria-label"), "Hide comments")
    await toast.waitFor({ state: "detached", timeout: 5000 })
    await page.keyboard.press("c")
    await page.waitForFunction(() => !document.documentElement.classList.contains("vitehub-comment-mode"))
    assert.equal(await eye.getAttribute("aria-label"), "Hide comments")
  })

  const panel = page.locator("[data-slot='comment-panel']")
  const windowHost = page.locator("vitehub-window")
  const layout = () => panel.evaluate((element) => {
    const header = element.querySelector("[data-slot='comment-panel-header']")
    const boxes = [...header.querySelectorAll("button, a")].map(item => item.getBoundingClientRect())
    const middle = boxes[0].top + boxes[0].height / 2
    const t3 = header.querySelector("[data-action='open-in-t3-code']")
    const label = t3?.querySelector("span")
    return {
      oneRow: boxes.every(box => box.top < middle && box.bottom > middle),
      apart: header.querySelector("[data-slot='comment-panel-filters']").getBoundingClientRect().right <= header.querySelector("[data-slot='comment-panel-actions']").getBoundingClientRect().left,
      fits: header.scrollWidth <= header.clientWidth,
      actions: [...header.querySelectorAll("[data-slot='comment-panel-actions'] [data-action]")].map(item => item.dataset.action),
      t3Label: label ? getComputedStyle(label).display !== "none" : false,
      heading: Boolean(element.querySelector("h2")),
      composer: Boolean(element.querySelector("[data-slot='comment-panel-composer']")),
      list: element.querySelector("[data-slot='comment-panel-items']")?.getAttribute("aria-label"),
      filters: [...header.querySelectorAll("[role=radio]")].map(item => item.textContent.trim()),
      color: getComputedStyle(element).color,
    }
  })
  const resize = width => windowHost.evaluate((host, width) => { host.shadowRoot.querySelector(".window").style.cssText += `;width:${width}px;min-width:0` }, width)

  await t.test("All comments opens one row of filters and actions, with no path, no Expand and no composer", async () => {
    await page.keyboard.press("c")
    await tool.getByTitle("All comments on this page").click()
    await panel.waitFor({ timeout: 5000 })
    const header = await windowHost.evaluate(host => [...host.shadowRoot.querySelector("header").children].map(child => child.getAttribute("aria-label") ?? child.textContent.trim()))
    assert.deepEqual(header, ["Comments", "Minimize window"])
    assert.equal(await windowHost.evaluate(host => host.shadowRoot.querySelector(".expand")), null)
    await resize(600)
    await page.waitForTimeout(200)
    const wide = await layout()
    assert.deepEqual({ ...wide, color: undefined }, { oneRow: true, apart: true, fits: true, actions: ["copy-page-prompt", "open-in-t3-code"], t3Label: true, heading: false, composer: false, list: "/", filters: ["Open 2", "Resolved 1"], color: undefined })
    assert.ok(luminance(wide.color) < 100, `light page, dark text: ${wide.color}`)
    assert.equal(await windowHost.evaluate(host => host.style.colorScheme), "light")
    await page.evaluate(() => navigator.clipboard.writeText(""))
    await panel.locator("[data-action='copy-page-prompt']").click()
    assert.equal(await clipboard(), prompt)
    assert.match(await panel.locator("[data-action='copy-page-prompt']").textContent(), /Copied/)
    if (evidence) await windowHost.screenshot({ path: `${evidence}/panel-light-600.png` })
    await resize(320)
    await page.waitForTimeout(200)
    const narrow = await layout()
    assert.deepEqual([narrow.oneRow, narrow.apart, narrow.fits, narrow.t3Label], [true, true, true, false])
    if (evidence) await windowHost.screenshot({ path: `${evidence}/panel-light-320.png` })
    await resize(190)
    await page.waitForTimeout(200)
    const tight = await layout()
    assert.deepEqual([tight.oneRow, tight.apart, tight.fits], [true, true, true])
    await panel.getByRole("button", { name: "Copy prompt" }).click({ trial: true })
    await panel.getByRole("radio", { name: /Open/ }).click({ trial: true })
    await panel.getByRole("radio", { name: /Resolved/ }).click({ trial: true })
    await resize(320)
  })

  await t.test("the panel follows the page into dark and back", async () => {
    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await page.waitForFunction(() => document.querySelector("vitehub-window").style.colorScheme === "dark")
    await page.waitForTimeout(200)
    const dark = await layout()
    assert.ok(luminance(dark.color) > 180, `dark page, light text: ${dark.color}`)
    assert.deepEqual([dark.oneRow, dark.apart, dark.fits], [true, true, true])
    if (evidence) await windowHost.screenshot({ path: `${evidence}/panel-dark-320.png` })
    await resize(600)
    await page.waitForTimeout(200)
    if (evidence) await windowHost.screenshot({ path: `${evidence}/panel-dark-600.png` })
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
    await page.waitForFunction(() => document.querySelector("vitehub-window").style.colorScheme === "light")
    assert.ok(luminance((await layout()).color) < 100)
  })

  assert.deepEqual(errors, [])
})
