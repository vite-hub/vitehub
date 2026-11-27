import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { test } from "node:test"
import { hostedCommentsLoader } from "@vite-hub/internal/runtime/page-tools-shared"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer as createViteServer } from "vite"

const consolePort = Number(process.env.COMMENTS_HOSTED_CONSOLE_PORT ?? 4798)
const sitePort = Number(process.env.COMMENTS_HOSTED_SITE_PORT ?? 4799)
const consoleOrigin = `http://127.0.0.1:${consolePort}`
const siteOrigin = `http://localhost:${sitePort}`
const hosted = new URL("../../dist/hosted/", import.meta.url)
const harness = fileURLToPath(new URL("../harness.ts", import.meta.url))
const handlerFile = fileURLToPath(new URL("../../src/runtime/handler.ts", import.meta.url))
const projects = { "p-1": siteOrigin, "p-2": "http://localhost:1", "p-3": siteOrigin, "p-4": siteOrigin, "p-5": siteOrigin }
const signInLanding = { "p-3": "/app/", "p-4": "/linked/", "p-5": "/linked/" }
const consoleKey = "k".repeat(43)
const secondKey = "t".repeat(43)
const staleKey = "x".repeat(43)
const projectKeys = { [consoleKey]: { id: "p-4", team: "First team" }, [secondKey]: { id: "p-5", team: "Second team" } }
const token = "token-1"

const sitePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Guide</title></head><body>
<main><h1>Guide</h1><p id="first">Most of you will fly in on Friday and leave on Sunday.</p></main>
<vitehub-pill>App tools</vitehub-pill>
<script type="module" src="${consoleOrigin}/hosted-comments.js" data-vitehub-comments="p-1" data-vitehub-repo="acme/site"></script>
</body></html>`

const vueRouterHashHistoryPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title>
<script>if (!location.hash.startsWith("#/")) history.replaceState(history.state, "", \`#/\${location.hash.slice(1)}\`)</script>
</head><body>
<main><h1>App</h1><p>Each route lives in the fragment.</p></main>
<script type="module" src="${consoleOrigin}/hosted-comments.js" data-vitehub-comments="p-3"></script>
</body></html>`

const linkedPage = (base, keys) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recipe</title>
</head><body><main><h1>Recipe</h1><p>Black garlic aioli.</p></main>${hostedCommentsLoader(consoleOrigin, keys, base)}</body></html>`
const linkedCsp = `default-src 'none'; script-src ${consoleOrigin} 'sha256-QN3vOPFNF4N34TjoyRt7mEGXSq1o76L7o2kIzzmWCUA='; frame-src ${consoleOrigin}; connect-src ${consoleOrigin}; style-src 'unsafe-inline'`

const base64url = value => createHash("sha256").update(value).digest("base64url")

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

async function fakeConsole() {
  const vite = await createViteServer({ configFile: false, logLevel: "warn", appType: "custom", optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
  const [{ createComments }, { createCommentsHandler }] = await Promise.all([vite.ssrLoadModule(harness), vite.ssrLoadModule(handlerFile)])
  const comments = await createComments()
  const handler = createCommentsHandler({ comments, realtime: false, session: async () => ({ id: "u1", name: "Maxi" }) })
  const seen = { challenges: [], codes: new Map(), api: [], projects: [] }
  const hold = { threads: undefined }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, consoleOrigin)
    const script = /^\/(hosted-comments\.js|hosted-comments\/[\w.-]+\.js)$/.exec(url.pathname)
    if (script) {
      const file = await readFile(new URL(script[1], hosted)).catch(() => undefined)
      if (!file) return send(res, 404, {}, "")
      return send(res, 200, { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" }, file)
    }
    if (url.pathname === "/comments/project") {
      const keys = url.searchParams.getAll("key")
      const base = url.searchParams.get("base")
      seen.projects.push({ keys, base, origin: req.headers.origin, cookie: req.headers.cookie })
      const matches = keys.map(key => projectKeys[key]).filter(entry => entry && projects[entry.id] === req.headers.origin && base === "/linked")
      const headers = { "content-type": "application/json", ...req.headers.origin ? { "access-control-allow-origin": req.headers.origin } : {} }
      if (!matches.length) return send(res, 404, headers, JSON.stringify({ error: "No project." }))
      return send(res, 200, headers, JSON.stringify({ projects: matches }))
    }
    if (url.pathname === "/open") return send(res, 200, { "content-type": "text/plain" }, "Console project")
    const route = /^\/comments\/([^/]+)\/(embed|authorize|redeem|api\/.*)$/.exec(url.pathname)
    const project = route && projects[route[1]]
    if (!project) return send(res, 404, {}, "")
    if (route[2] === "embed") {
      return send(res, 200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${project}`,
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "cross-origin",
      }, `<!doctype html><html data-origin="${project}" data-project="${route[1]}"><head><meta charset="utf-8"><script type="module" src="/hosted-comments/frame.js"></script></head></html>`)
    }
    if (route[2] === "authorize") {
      const challenge = url.searchParams.get("challenge")
      const code = `code-${seen.challenges.push(challenge)}`
      seen.codes.set(code, challenge)
      const target = new URL(signInLanding[route[1]] ?? "/guide/", project)
      if (url.searchParams.has("linked")) target.searchParams.set("vhp", route[1])
      target.hash = `vhc=${code}`
      return send(res, 302, { location: target.href }, "")
    }
    if (route[2] === "redeem") {
      const input = JSON.parse((await body(req)).toString())
      const challenge = seen.codes.get(input.code)
      seen.codes.delete(input.code)
      if (!challenge || base64url(input.verifier) !== challenge || req.headers.cookie) return send(res, 400, { "content-type": "application/json" }, JSON.stringify({ error: { code: "TEST_REDEEM", why: "Wrong code." } }))
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({ token }))
    }
    seen.api.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization, cookie: req.headers.cookie })
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { "content-type": "application/json" }, JSON.stringify({ error: { code: "TEST_UNAUTHORIZED", why: "Sign in." } }))
    if (req.method === "POST" && route[2] === "api/threads") await hold.threads
    const headers = new Headers(Object.entries(req.headers).filter(([name]) => !["host", "origin", "cookie", "authorization"].includes(name)))
    const forwarded = new Request(`${project}/_vitehub/comments/${route[2].slice("api/".length)}${url.search}`, { method: req.method, headers, body: await body(req) })
    const response = await handler.fetch(forwarded)
    send(res, response.status, Object.fromEntries(response.headers), Buffer.from(await response.arrayBuffer()))
  })
  await new Promise(resolve => server.listen(consolePort, "127.0.0.1", resolve))
  return { server, vite, seen, hold, threads: async () => (await comments.list())[1] }
}

async function fakeSite() {
  const server = createServer((req, res) => {
    const base = req.url.startsWith("/linked/") ? "/linked" : req.url.startsWith("/stale/") ? "/stale" : ""
    const headers = { "content-type": "text/html; charset=utf-8", ...(base ? { "content-security-policy": linkedCsp } : {}) }
    return send(res, 200, headers, base ? linkedPage(base, base === "/linked" ? [consoleKey, secondKey] : [staleKey]) : req.url.startsWith("/app/") ? vueRouterHashHistoryPage : sitePage)
  })
  await new Promise(resolve => server.listen(sitePort, "localhost", resolve))
  return server
}

const close = server => new Promise(resolve => server.close(() => resolve()))

test("hosted Comments sign in through a new tab and comment through the Console frame", { timeout: 120_000 }, async (t) => {
  const api = await fakeConsole()
  t.after(() => Promise.all([close(api.server), api.vite.close()]))
  const site = await fakeSite()
  t.after(() => close(site))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))

  await page.goto(`${siteOrigin}/guide/?vitehub`)
  await page.getByRole("button", { name: "Comments", exact: true, disabled: false }).click({ timeout: 20_000 })
  const signIn = page.locator("vitehub-comments a", { hasText: "Sign in to ViteHub" })
  await signIn.waitFor({ timeout: 20_000 })
  assert.equal(await signIn.getAttribute("target"), "_blank")
  assert.equal(await signIn.getAttribute("rel"), "noopener noreferrer")
  const href = new URL(await signIn.getAttribute("href"))
  assert.equal(href.origin, consoleOrigin)
  assert.equal(href.pathname, "/comments/p-1/authorize")
  assert.deepEqual([...href.searchParams.keys()], ["challenge"])
  assert.equal(await page.evaluate(() => document.cookie), "")

  await t.test("the new tab hands the code to the first tab and closes", async () => {
    const [callback] = await Promise.all([context.waitForEvent("page"), signIn.click()])
    await callback.waitForEvent("close", { timeout: 20_000 })
    assert.equal(api.seen.codes.size, 0, "the code was redeemed once")
    assert.equal(new URL(page.url()).hash, "")
    assert.equal(await page.locator("vitehub-pill").textContent(), "App tools")
    assert.equal(await page.locator("vitehub-hosted-comments-pill").count(), 1)
  })

  await t.test("the first tab comes back as the person left it, with the Comments window closed", async () => {
    await page.getByTitle("Comment on the page (C)").waitFor({ timeout: 20_000 })
    assert.equal(await page.locator("vitehub-window").count(), 0)
  })

  await t.test("the signed-in person comments on selected text, with the token only in the frame", async () => {
    await page.locator("vitehub-comments [data-slot='comment-layer']").waitFor({ state: "attached", timeout: 20_000 })
    const box = await page.locator("#first").boundingBox()
    await page.mouse.move(box.x + 2, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, box.y + 10, { steps: 10 })
    await page.mouse.up()
    const bar = page.locator("vitehub-comments [data-slot='comment-selection-bar']")
    await bar.waitFor({ timeout: 10_000 })
    await bar.getByRole("button", { name: /Comment/ }).click()
    const composer = page.locator("vitehub-comments textarea[aria-label='Comment']")
    await composer.waitFor({ timeout: 5000 })
    await composer.fill("Say which airport")
    let release
    api.hold.threads = new Promise(resolve => release = resolve)
    try {
      await composer.press("Enter")
      await composer.waitFor({ state: "detached", timeout: 2000 })
      await page.waitForFunction(() => CSS.highlights.get("vh-comment")?.size === 1, undefined, { timeout: 10_000 })
      for (let tries = 0; !api.seen.api.some(request => request.method === "POST" && request.path === "/comments/p-1/api/threads") && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 100))
      assert.deepEqual(await api.threads(), [])
    }
    finally {
      api.hold.threads = undefined
      release()
    }
    let thread
    for (let tries = 0; !thread && tries < 100; tries++) {
      [thread] = await api.threads()
      if (!thread) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(thread.messages[0].body, "Say which airport")
    assert.equal(thread.author.id, "u1")
    assert.equal(thread.context.url, `${siteOrigin}/guide`)
    const signedIn = api.seen.api.filter(request => request.authorization)
    assert.ok(signedIn.some(request => request.path === "/comments/p-1/api/threads"))
    assert.ok(api.seen.api.every(request => !request.cookie))
    const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))
    assert.doesNotMatch(storage, new RegExp(token))
  })

  await t.test("the mobile panel shows filters and bulk actions with the repository after sign-in", async () => {
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 375, height: 720 })
    try {
      await page.getByTitle("Comment on the page (C)").click()
      await page.getByTitle("All comments on this page").click()
      const panel = page.locator('[data-slot="comment-panel"]')
      const open = panel.getByRole("link", { name: "Open in T3 Code" })
      await open.waitFor()
      assert.equal(new URL(await open.getAttribute("href")).searchParams.get("repo"), "acme/site")
      await open.click({ trial: true })
      await panel.getByRole("button", { name: "Copy open" }).click({ trial: true })
      await panel.getByRole("radio", { name: /Open/ }).click({ trial: true })
      await panel.getByRole("radio", { name: /Resolved/ }).click({ trial: true })
      assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth))
    }
    finally {
      await page.setViewportSize(viewport)
    }
  })

  await t.test("the person replies and resolves through the frame, and may not edit or delete", async () => {
    await page.keyboard.press("Escape")
    await page.locator("vitehub-comments [data-slot='comment-pin']").first().click()
    const reply = page.locator("vitehub-comments textarea[aria-label='Reply']")
    await reply.waitFor({ timeout: 5000 })
    assert.equal(await page.locator("vitehub-comments").getByRole("button", { name: "Edit" }).count(), 0)
    assert.equal(await page.locator("vitehub-comments").getByRole("button", { name: "Delete" }).count(), 0)
    await reply.fill("Terminal 2")
    await reply.press("Enter")
    await page.locator("vitehub-comments").getByText("Terminal 2").waitFor({ timeout: 5000 })
    await page.locator("vitehub-comments").getByRole("button", { name: "Resolve" }).click()
    let thread
    for (let attempt = 0; attempt < 50 && thread?.status !== "resolved"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      [thread] = await api.threads()
    }
    assert.deepEqual(thread.messages.map(message => message.body), ["Say which airport", "Terminal 2"])
    assert.equal(thread.status, "resolved")
  })

  await t.test("the frame of a project registered for another origin does not connect", async () => {
    const ready = await page.evaluate(async (src) => {
      const frame = Object.assign(document.createElement("iframe"), { src, hidden: true })
      const channel = new MessageChannel()
      const answer = new Promise(resolve => {
        channel.port1.onmessage = ({ data }) => resolve(data?.event === "ready")
        setTimeout(() => resolve(false), 2000)
      })
      frame.addEventListener("load", () => frame.contentWindow.postMessage({ type: "vitehub-comments:connect" }, "*", [channel.port2]), { once: true })
      document.body.append(frame)
      return await answer
    }, `${consoleOrigin}/comments/p-2/embed`)
    assert.equal(ready, false)
  })

  assert.deepEqual(errors, [])
})

test("hosted Comments sign in on a site whose router rewrites the fragment first", { timeout: 120_000 }, async (t) => {
  const api = await fakeConsole()
  t.after(() => Promise.all([close(api.server), api.vite.close()]))
  const site = await fakeSite()
  t.after(() => close(site))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))

  await page.goto(`${siteOrigin}/app/?vitehub`)
  await page.getByRole("button", { name: "Comments", exact: true, disabled: false }).click({ timeout: 20_000 })
  const signIn = page.locator("vitehub-comments a", { hasText: "Sign in to ViteHub" })
  await signIn.waitFor({ timeout: 20_000 })
  const [callback] = await Promise.all([context.waitForEvent("page"), signIn.click()])
  await callback.waitForEvent("close", { timeout: 20_000 })
  assert.equal(api.seen.codes.size, 0, "the code was redeemed once")
  assert.equal(new URL(page.url()).hash, "#/", "the first tab keeps its route")
  assert.equal(await page.locator("vitehub-hosted-comments-pill").count(), 1)
  assert.deepEqual(errors, [])
})

test("the Hosted Comments pill of a ViteHub app finds its project from the Console keys of the page", { timeout: 120_000 }, async (t) => {
  const api = await fakeConsole()
  t.after(() => Promise.all([close(api.server), api.vite.close()]))
  const site = await fakeSite()
  t.after(() => close(site))
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))

  await page.goto(`${siteOrigin}/linked/`)
  await page.waitForLoadState("networkidle")
  assert.deepEqual(api.seen.projects, [], "a page without a hint asks the Console nothing")
  assert.equal(await page.locator("vitehub-hosted-comments-pill").count(), 0)

  await page.goto(`${siteOrigin}/linked/?vitehub`)
  await page.getByRole("combobox", { name: "Choose a team for Comments" }).selectOption({ label: "Second team" }, { timeout: 20_000 })
  await page.getByRole("button", { name: "Comments", exact: true, disabled: false }).click({ timeout: 20_000 })
  assert.deepEqual(api.seen.projects, [{ keys: [consoleKey, secondKey], base: "/linked", origin: siteOrigin, cookie: undefined }])
  const signIn = page.locator("vitehub-comments a", { hasText: "Sign in to ViteHub" })
  await signIn.waitFor({ timeout: 20_000 })
  assert.equal(new URL(await signIn.getAttribute("href")).pathname, "/comments/p-5/authorize")
  const [callback] = await Promise.all([context.waitForEvent("page"), signIn.click()])
  await callback.waitForEvent("close", { timeout: 20_000 })
  assert.equal(api.seen.codes.size, 0, "the sign-in tab on the linked page redeemed the code")
  await page.getByTitle("Comment on the page (C)").waitFor({ timeout: 20_000 })

  await page.goto(`${siteOrigin}/linked/other`)
  const consoleLink = page.getByRole("link", { name: "Console", exact: true })
  await consoleLink.click({ timeout: 20_000 })
  assert.equal(new URL(page.url()).searchParams.get("app"), "p-5")
  assert.equal(new URL(page.url()).searchParams.get("project"), `${siteOrigin}/linked`)

  await page.goto(`${siteOrigin}/stale/?vitehub`)
  await consoleLink.click({ timeout: 20_000 })
  assert.equal(new URL(page.url()).searchParams.get("app"), null)
  assert.equal(new URL(page.url()).searchParams.get("project"), `${siteOrigin}/stale`)
  assert.deepEqual(errors, [])
})
