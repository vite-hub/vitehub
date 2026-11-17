// Renders every part that uses a Nuxt UI component by name with the ui-sdk set (`uiSdkComponents`) and the kit style
// family, in headless Chromium, and drives each one with the keyboard and the pointer. The page is `ui-sdk/`.
//
// Run: pnpm --filter @vite-hub/ui test:ui-sdk
// Set UI_SDK_SCREENSHOTS=<dir> to save a screenshot of the page.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = fileURLToPath(new URL("./ui-sdk/", import.meta.url))
const fakeWebContainer = join(root, "fake-web-container.ts")
const webContainerSource = fileURLToPath(new URL("../../../web-container/src/", import.meta.url))
const screenshots = process.env.UI_SDK_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [
    vue(),
    {
      // The page runs without Nuxt UI. The parts import a Nuxt UI component only for a name that no component replaces,
      // so each of those imports becomes a component that fails the page when it renders.
      name: "no-nuxt-ui",
      enforce: "pre",
      resolveId: id => id.startsWith("@nuxt/ui/") ? `\0no-nuxt-ui:${id}` : undefined,
      load: id => id.startsWith("\0no-nuxt-ui:")
        ? `export default { name: "NoNuxtUI", setup() { throw new Error(${JSON.stringify(`A part rendered ${id.slice("\0no-nuxt-ui:".length)}`)}); } };`
        : undefined,
    },
    {
      // PlaygroundContainer boots a WebContainer. The page boots a fake one, from the sources of its Vue composable.
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

/** @type {import("playwright-core").Page} */
let page
const errors = []
before(async () => {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(base).origin })
  page = await context.newPage()
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => message.type() === "error" && errors.push(message.text()))
  await page.goto(base)
  await page.locator("[data-part-name=PlaygroundContainer]").waitFor()
  if (screenshots) await page.screenshot({ fullPage: true, path: join(screenshots, "ui-sdk.png") })
})

const part = name => page.locator(`[data-part-name="${name}"]`)
const events = () => page.evaluate(() => window.events)
const focused = () => page.evaluate(() => {
  const element = document.activeElement
  return element ? `${element.localName}${element.getAttribute("aria-label") ? ` "${element.getAttribute("aria-label")}"` : ""}` : ""
})

test("loads no Nuxt UI module and throws nothing", async () => {
  const modules = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name))
  assert.deepEqual(modules.filter(name => name.includes("@nuxt/ui") || name.includes("@nuxt_ui")), [])
  assert.deepEqual(errors, [])
})

test("every seam icon draws its shapes", async () => {
  const empty = await page.evaluate(() => [...document.querySelectorAll("main svg[viewBox='0 0 24 24']")]
    .filter(svg => svg.childElementCount === 0 && svg.checkVisibility())
    .map(svg => svg.closest("[data-part-name]")?.getAttribute("data-part-name")))
  assert.deepEqual(empty, [])
})

test("buttons carry the kit button slot, and a part's own name in data-part", async () => {
  const copy = part("CopyButton").getByRole("button", { name: "Copy" })
  assert.equal(await copy.getAttribute("data-slot"), "button")
  assert.equal(await copy.getAttribute("data-part"), "copy-button")
  assert.equal(await copy.getAttribute("data-variant"), "ghost")
  // The kit draws a ghost button without a border or a fill.
  const style = await copy.evaluate(element => getComputedStyle(element))
  assert.equal(style.borderTopColor, "rgba(0, 0, 0, 0)")
  assert.equal(style.backgroundColor, "rgba(0, 0, 0, 0)")
})

test("CopyButton copies with Enter", async () => {
  await part("CopyButton").getByRole("button", { name: "Copy" }).focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => window.events.includes("copy"))
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "vitehub")
  assert.equal(await part("CopyButton").locator("[data-copied]").count(), 1)
})

test("FilterSearch types, submits with Enter, and clears with Escape and with its clear button", async () => {
  const input = part("FilterSearch").getByRole("textbox", { name: "Filter sessions" })
  assert.equal(await input.getAttribute("data-slot"), "input")
  assert.equal(await input.getAttribute("data-part"), "choices-input-field")
  await input.focus()
  await page.keyboard.type("kv")
  assert.equal(await part("FilterSearch").locator("output").textContent(), "kv")
  await page.keyboard.press("Enter")
  assert.ok((await events()).includes("filter:submit:kv"))
  await page.keyboard.press("Escape")
  assert.equal(await input.inputValue(), "")
  await page.keyboard.type("blob")
  const clear = part("FilterSearch").getByRole("button", { name: "Clear" })
  await clear.click()
  assert.equal(await input.inputValue(), "")
  assert.equal(await clear.count(), 0)
})

test("PromptInput sends with Enter and offers its attachment button", async () => {
  const box = part("PromptInput").getByRole("textbox")
  await box.focus()
  await page.keyboard.type("Hello")
  await page.keyboard.press("Enter")
  assert.ok((await events()).includes("prompt:submit:Hello"))
  const attach = part("PromptInput").locator("button[aria-label='Add attachment']")
  assert.equal(await attach.getAttribute("data-size"), "sm")
  assert.ok(await attach.locator("svg path").count())
})

test("AttachmentAction runs with Space", async () => {
  await part("Attachment").getByRole("button", { name: "Remove notes.txt" }).focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("Enter")
  // One press, one action.
  assert.deepEqual((await events()).filter(event => event === "attachment:remove"), ["attachment:remove", "attachment:remove"])
})

test("the image preview opens a dialog with Enter, traps Tab, and closes with Escape and with its button", async () => {
  const trigger = part("MessageParts").getByRole("button", { name: "Preview pixel.png" })
  // The trigger keeps its own look, not the kit button's.
  assert.equal(await trigger.getAttribute("data-slot"), null)
  await trigger.focus()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "pixel.png" })
  await dialog.waitFor()
  assert.equal(await dialog.getAttribute("class"), "vh-image-dialog")
  const inside = await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))
  assert.ok(inside, `focus is on ${await focused()}, outside the dialog`)
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press("Tab")
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")), `Tab left the dialog to ${await focused()}`)
  }
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  assert.equal(await focused(), "button \"Preview pixel.png\"")
  await page.keyboard.press("Enter")
  await dialog.waitFor()
  await dialog.getByRole("button", { name: "Close image preview" }).click()
  await dialog.waitFor({ state: "hidden" })
})

test("TraceRun and AgentSession draw their status and tab icons", async () => {
  assert.ok(await part("TraceRun").locator("svg path, svg circle").count())
  assert.ok(await part("AgentSession").locator("svg path, svg circle, svg rect").count())
})

test("CommentThread resolves with Enter", async () => {
  await part("CommentThread").getByRole("button", { name: "Resolve" }).focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => window.events.includes("thread:resolve"))
})

test("CommentPanel filters toggle with the keyboard", async () => {
  const filters = part("CommentPanel").locator("[data-part=comment-panel-filter]")
  assert.ok(await filters.count() >= 2)
  const second = filters.nth(1)
  await second.focus()
  await page.keyboard.press("Enter")
  assert.equal(await second.getAttribute("aria-pressed"), "true")
})

test("CommentToolbar and CommentList toggle their buttons", async () => {
  const mode = part("CommentList").getByRole("button", { name: "Comment mode" })
  await mode.focus()
  await page.keyboard.press("Enter")
  assert.equal(await mode.getAttribute("aria-pressed"), "true")
  assert.equal(await mode.getAttribute("data-variant"), "solid")
  await page.keyboard.press("Enter")
  assert.equal(await mode.getAttribute("aria-pressed"), "false")
  const scopes = part("CommentList").locator("[data-part=comment-list-scope]")
  const off = scopes.nth((await scopes.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-pressed")))).indexOf("false"))
  await off.focus()
  await page.keyboard.press("Space")
  assert.equal(await off.getAttribute("aria-pressed"), "true")
})

test("the Chat scroll button shows above the end and scrolls back with Enter", async () => {
  const button = part("Chat").locator(".vh-chat__scroll-button")
  await part("Chat").locator("[data-slot=message-scroller-viewport], .vh-chat [data-slot*=scroller]").first().evaluate(element => element.scrollTo({ top: 0 }))
  await page.waitForFunction(() => !document.querySelector("[data-part-name=Chat] .vh-chat__scroll-button")?.hidden)
  await button.focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.querySelector("[data-part-name=Chat] .vh-chat__scroll-button")?.hidden)
})

test("ConnectPanel focuses its token field, which types and closes with Escape", async () => {
  await part("ConnectPanel").getByRole("button", { name: "Connect Vercel" }).click()
  const field = part("ConnectPanel").locator("input[type=password]")
  await field.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("type")), "password")
  assert.equal(await field.evaluate(element => element.parentElement?.getAttribute("data-slot")), "input-group")
  await page.keyboard.type("token")
  assert.equal(await field.inputValue(), "token")
  assert.equal(await part("ConnectPanel").getByRole("button", { name: "Save" }).isEnabled(), true)
  await page.keyboard.press("Escape")
  await field.waitFor({ state: "detached" })
})

test("WorkspacePreview edits its path field", async () => {
  const field = part("WorkspacePreview").getByLabel("Preview path")
  await field.fill("/about")
  assert.equal(await field.inputValue(), "/about")
})

test("WorkspaceShell tabs move with the arrow keys and show their badge", async () => {
  const tabs = part("WorkspaceShell").getByRole("tab")
  assert.deepEqual(await tabs.allTextContents(), ["Console", "Messages2"])
  await tabs.first().click()
  assert.equal(await tabs.first().getAttribute("aria-selected"), "true")
  await page.keyboard.press("ArrowRight")
  assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true")
  assert.equal(await focused(), "button")
  assert.ok(await part("WorkspaceShell").locator("[data-tab=messages]:not([inert])").count())
  await page.keyboard.press("Home")
  assert.equal(await tabs.first().getAttribute("aria-selected"), "true")
})

test("PlaygroundContainer: the template menu and the More actions menu work with the keyboard", async () => {
  const container = part("PlaygroundContainer")
  // Template menu: Enter opens it, the arrow keys move, Enter picks, and focus returns to the trigger.
  const trigger = container.getByRole("button", { name: "Template: KV" })
  await trigger.focus()
  await page.keyboard.press("Enter")
  const menu = page.getByRole("menu")
  await menu.waitFor()
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["KV", "Blob"])
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await menu.waitFor({ state: "hidden" })
  await container.getByRole("button", { name: "Template: Blob" }).waitFor()
  // More actions: Escape closes the menu and focus goes back to its trigger.
  const more = container.getByRole("button", { name: "More actions" })
  await more.focus()
  await page.keyboard.press("Enter")
  await menu.waitFor()
  assert.equal(await menu.getByRole("menuitem", { name: "Discard changes" }).getAttribute("aria-disabled"), "true")
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "hidden" })
  assert.equal(await focused(), "button \"More actions\"")
  // After an edit, a template change asks first, in a dialog with a footer: Escape keeps the files, the button replaces them.
  await container.locator(".cm-content").click()
  await page.keyboard.type("// edit")
  await container.getByRole("button", { name: "Template: Blob" }).click()
  await menu.waitFor()
  await menu.getByRole("menuitem", { name: "KV" }).click()
  const dialog = page.getByRole("dialog", { name: "Open the KV template?" })
  await dialog.waitFor()
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")), `focus is on ${await focused()}, outside the dialog`)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  await container.getByRole("button", { name: "Template: Blob" }).waitFor()
  await container.getByRole("button", { name: "Template: Blob" }).click()
  await menu.getByRole("menuitem", { name: "KV" }).click()
  await dialog.getByRole("button", { name: "Replace files" }).click()
  await dialog.waitFor({ state: "hidden" })
  await container.getByRole("button", { name: "Template: KV" }).waitFor()
})
