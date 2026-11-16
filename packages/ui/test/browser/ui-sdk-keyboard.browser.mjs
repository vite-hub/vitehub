// Run from packages/ui: node --test test/browser/ui-sdk-keyboard.browser.mjs
import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("../../", import.meta.url))
const core = realpathSync(`${root}/node_modules/@ui-sdk/core`)
const server = await createServer({ configFile: false, root, server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const browser = await chromium.launch()
after(async () => { await browser.close(); await server.close() })
const popup = readFileSync(`${core}/dist/foundation/popups/popup.js`, "utf8")
// Exercise the installed internal guard without adding a public SDK export.
const guard = popup.slice(popup.indexOf("var frameGuardStyle"), popup.indexOf("function modalTriple"))

async function open() {
  const page = await browser.newPage()
  await page.goto(server.resolvedUrls.local[0])
  await page.evaluate(async (core) => {
    window.forms = await import(`/@fs/${core}/dist/foundation/forms/form.js`)
    window.platform = await import(`/@fs/${core}/dist/foundation/platform/platform.js`)
    window.tabbable = await import(`/@fs/${core}/dist/foundation/focus/tabbable.js`)
    window.events = await import(`/@fs/${core}/dist/foundation/kernel/events.js`)
  }, core)
  return page
}

test("Enter in registered segments follows single-field implicit submission rules", async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      document.body.innerHTML = '<form><input id="day"><input id="month"><input id="year"></form>'
      window.submits = 0
      const group = {}
      document.querySelectorAll("input").forEach(input => forms.bindFieldPart(input, group))
      document.querySelector("form").addEventListener("submit", e => { e.preventDefault(); window.submits++ })
    })
    await page.locator("#day").press("Enter")
    assert.equal(await page.evaluate(() => window.submits), 1)
    for (const options of [{ isComposing: true }, {}]) {
      await page.evaluate(options => {
        const input = document.querySelector("input")
        if (!options.isComposing) input.addEventListener("keydown", e => e.preventDefault(), { once: true })
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }))
      }, options)
      assert.equal(await page.evaluate(() => window.submits), 1)
    }
    await page.evaluate(() => document.querySelector("form").appendChild(document.createElement("input")))
    await page.locator("#day").press("Enter")
    assert.equal(await page.evaluate(() => window.submits), 1)
    await page.evaluate(() => {
      document.querySelector("form").lastElementChild.remove()
      const second = {}
      for (let i = 0; i < 3; i++) {
        const input = document.createElement("input")
        document.querySelector("form").appendChild(input)
        forms.bindFieldPart(input, second)
      }
    })
    await page.locator("#day").press("Enter")
    assert.equal(await page.evaluate(() => window.submits), 1)
    await page.evaluate(() => {
      const button = document.createElement("button")
      button.textContent = "Submit"
      document.querySelector("form").appendChild(button)
    })
    await page.locator("#day").press("Enter")
    assert.equal(await page.evaluate(() => window.submits), 2)
  } finally { await page.close() }
})

for (const shadowFrame of [false, true]) {
  test(`iframe exit preserves composed order (shadow iframe: ${shadowFrame})`, async () => {
    const page = await open()
    try {
      await page.evaluate(({ guard, shadowFrame }) => {
        document.body.innerHTML = '<div id="popup"><button id="first">First</button><div id="frameHost"></div><div id="shadowHost"></div><button id="last">Last</button></div>'
        const host = document.querySelector("#frameHost")
        const container = shadowFrame ? host.attachShadow({ mode: "open" }) : host
        const frame = document.createElement("iframe")
        frame.srcdoc = '<input id="inside">'
        container.appendChild(frame)
        document.querySelector("#shadowHost").attachShadow({ mode: "open" }).innerHTML = '<button id="shadow">Shadow</button>'
        const setup = new Function("on", "activeElement", "composedContains", "composedTabbables", "tabbables", `${guard}; return guardFrames`)
        window.cleanup = setup(events.on, platform.activeElement, platform.composedContains, tabbable.composedTabbables, tabbable.tabbables)(document.querySelector("#popup"), () => true)
      }, { guard, shadowFrame })
      const input = page.frameLocator("iframe").locator("input")
      await input.focus()
      await page.waitForFunction(() => {
        const host = document.querySelector("#frameHost")
        return (host.shadowRoot ?? host).querySelectorAll("span").length === 2
      })
      await input.press("Tab")
      assert.equal(await page.evaluate(() => platform.activeElement().id), "shadow")
      await input.focus()
      await page.waitForFunction(() => {
        const host = document.querySelector("#frameHost")
        return (host.shadowRoot ?? host).querySelectorAll("span").length === 2
      })
      await input.press("Shift+Tab")
      assert.equal(await page.evaluate(() => platform.activeElement().id), "first")
    } finally { await page.close() }
  })
}
