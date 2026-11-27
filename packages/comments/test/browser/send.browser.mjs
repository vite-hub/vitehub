import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_SEND_BROWSER_PORT ?? 4798)
const evidence = process.env.COMMENTS_BROWSER_EVIDENCE
const helper = fileURLToPath(new URL("./send-api.ts", import.meta.url))

function sendApi() {
  let api
  return {
    name: "comments-send-api",
    async configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/_vitehub/comments/")) return next()
        api ??= await (await server.ssrLoadModule(helper)).createSendApi()
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const response = await api.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }))
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
    api: async (server) => api ??= await (await server.ssrLoadModule(helper)).createSendApi(),
  }
}

async function agentPairs(prompt, url = "https://relay.t3.codes/hooks/wh_azores") {
  const code = /"code":"([^"]+)"/.exec(prompt)?.[1]
  assert.ok(code, "the prompt holds the code")
  const response = await fetch(`http://127.0.0.1:${port}/_vitehub/comments/send/pair`, { method: "POST", headers: { "content-type": "application/json", origin: "https://agent.example" }, body: JSON.stringify({ code, url }) })
  return response.status
}

test("Send in the ViteHub pill walks every state", { timeout: 180_000 }, async (t) => {
  const plugin = sendApi()
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    optimizeDeps: { noDiscovery: true },
    plugins: [standaloneUI(), plugin],
    resolve: { alias: overlayAliases, dedupe: ["vue"] },
    root: fileURLToPath(new URL("./send-page", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  t.after(() => server.close())
  const api = await plugin.api(server)
  await api.comment("ana", "The rental desk part is too long")
  await api.comment("bob", "Say when to order the cozido")

  const browser = await chromium.launch()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2 })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` })
  if (evidence) await mkdir(evidence, { recursive: true })
  const errors = []

  async function open(user) {
    await context.addCookies([{ name: "user", value: user, url: `http://127.0.0.1:${port}/` }])
    const page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}/`)
    return page
  }
  const segment = page => page.locator("vitehub-tool [data-slot='comment-send']")
  const pill = page => page.locator("vitehub-pill")
  async function shot(page, name) {
    if (!evidence) return
    await page.waitForTimeout(300)
    await pill(page).screenshot({ path: `${evidence}/${name}.png` })
  }
  const waitState = (page, value, reason) => page.waitForFunction(([value, reason]) => {
    const element = document.querySelector("vitehub-tool").shadowRoot?.querySelector("[data-slot='comment-send']")
    return element?.dataset.state === value && (reason === undefined || element.dataset.reason === reason)
  }, [value, reason], { timeout: 10_000 })

  const ana = await open("ana")

  await t.test("idle: Send 2 sits after the eye, in the Comments row", async () => {
    await waitState(ana, "idle")
    const send = segment(ana).locator("[data-action='send']")
    await send.waitFor()
    assert.equal(await send.getAttribute("aria-label"), "Send: 2 comments")
    const order = await ana.evaluate(() => [...document.querySelector("vitehub-tool").shadowRoot.querySelector(".toolbar").querySelectorAll(":scope > .lead > *, :scope > :not(.lead)")].map(child => child.dataset.slot ?? child.getAttribute("aria-label") ?? child.textContent.trim()))
    assert.deepEqual(order.slice(0, 3), ["Comments, 2 open", "Hide comments", "comment-send"])
    await shot(ana, "1-idle")
  })

  let prompt
  await t.test("pairing: Send copies the setup prompt", async () => {
    await segment(ana).locator("[data-action='send']").click()
    await waitState(ana, "pairing")
    prompt = await ana.evaluate(() => navigator.clipboard.readText())
    assert.match(prompt, /schedule_task/)
    assert.match(prompt, /\/_vitehub\/comments\/send\/pair/)
    assert.match(await segment(ana).textContent(), /Setup prompt copied\. Paste it in the T3 thread/)
    await shot(ana, "2-pairing")
  })

  await t.test("confirm: the agent pairs from another origin, and the pill asks once", async () => {
    assert.equal(await agentPairs(prompt), 200)
    await waitState(ana, "confirm")
    assert.match(await segment(ana).textContent(), /T3 Code · relay\.t3\.codes wants your comments from this site/)
    assert.match(await segment(ana).locator("[data-action='allow']").textContent(), /Allow and send 2/)
    await shot(ana, "3-confirm")
  })

  await t.test("sending, sent, then working", async () => {
    api.control.delay = 1500
    await segment(ana).locator("[data-action='allow']").click()
    await waitState(ana, "sending")
    await shot(ana, "4-sending")
    await waitState(ana, "sent")
    await shot(ana, "5-sent")
    assert.equal((await api.readDelivery()).status, 200)
    await waitState(ana, "working")
    assert.match(await segment(ana).textContent(), /Working/)
    await shot(ana, "6-working")
    api.control.delay = 0
    assert.equal(api.control.deliveries, 1)
  })

  await t.test("the agent answers: the pill clears", async () => {
    await api.resolveAll()
    await ana.reload()
    await ana.locator("vitehub-tool .toolbar").waitFor()
    await ana.waitForFunction(() => document.querySelector("vitehub-tool").shadowRoot?.querySelector("[data-slot='comment-send']")?.hidden === true)
  })

  await t.test("failed: Not delivered and Retry", async () => {
    await api.comment("bob", "And the bus times")
    await ana.reload()
    await waitState(ana, "idle")
    await segment(ana).locator("[data-action='send']").waitFor()
    api.control.fail = true
    await segment(ana).locator("[data-action='send']").click()
    await waitState(ana, "failed")
    assert.match(await segment(ana).textContent(), /Not delivered/)
    await shot(ana, "7-failed")
    api.control.fail = false
    await segment(ana).locator("[data-action='retry']").click()
    await waitState(ana, "sent")
    assert.equal((await api.readDelivery()).status, 200)
    await waitState(ana, "working")
  })

  await t.test("limited: the 31st send of the hour waits", async () => {
    await api.resolveAll()
    await api.fillHour("ana")
    await api.comment("bob", "One more")
    await ana.reload()
    await waitState(ana, "limited")
    assert.match(await segment(ana).textContent(), /Limit reached, try at \d\d:\d\d/)
    await shot(ana, "8-limited")
  })

  const bob = await open("bob")
  await t.test("refused: a URL that is not the T3 relay", async () => {
    await waitState(bob, "idle")
    await segment(bob).locator("[data-action='send']").click()
    await waitState(bob, "pairing")
    const copied = await bob.evaluate(() => navigator.clipboard.readText())
    assert.equal(await agentPairs(copied, "https://hooks.example.com/t3"), 422)
    await waitState(bob, "pairing", "refused")
    assert.match(await segment(bob).textContent(), /That URL isn't relay\.t3\.codes/)
    await shot(bob, "9-refused")
  })

  await t.test("expired: Copy again gives a new code", async () => {
    await segment(bob).locator("[data-action='copy-again']").click()
    await bob.waitForFunction(() => !document.querySelector("vitehub-tool").shadowRoot?.querySelector("[data-slot='comment-send']")?.dataset.reason)
    await api.expireCodes()
    await waitState(bob, "pairing", "expired")
    assert.match(await segment(bob).textContent(), /Setup code expired/)
    await shot(bob, "10-expired")
    await segment(bob).locator("[data-action='cancel']").click()
    await waitState(bob, "idle")
  })

  await t.test("navigation drops the previous page's confirmation", async () => {
    await segment(bob).locator("[data-action='send']").click()
    await waitState(bob, "pairing")
    assert.equal(await agentPairs(await bob.evaluate(() => navigator.clipboard.readText())), 200)
    await waitState(bob, "confirm")
    await bob.evaluate(() => history.pushState({}, "", "/another-page"))
    await waitState(bob, "idle")
    assert.equal(await segment(bob).locator("[data-action='allow']").count(), 0)
  })

  assert.deepEqual(errors, [])
})
