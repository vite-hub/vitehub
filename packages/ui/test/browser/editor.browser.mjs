// Drives the editor parts with the keyboard and the pointer, with Nuxt UI's parts and with the ui-sdk set
// (`uiSdkComponents`), in headless Chromium: the "/" menu, the bubble toolbar, the drag handle, and a block menu on the
// handle. Both sets run the same steps. The pages are `editor/nuxt-ui/` and `editor/ui-sdk/`.
//
// Run: pnpm --filter @vite-hub/ui test:editor
// Set EDITOR_SCREENSHOTS=<dir> to save a screenshot of each state.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import nuxtUi from "@nuxt/ui/vite"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const screenshots = process.env.EDITOR_SCREENSHOTS
if (screenshots) mkdirSync(screenshots, { recursive: true })

const sets = {
  "nuxt-ui": { plugins: [vue(), nuxtUi({ dts: false })] },
  "ui-sdk": {
    // The dependency scan follows the parts' Nuxt UI imports and fails on its `#build` aliases, which would leave the
    // optimizer to find dependencies while the test runs and reload the page.
    optimizeDeps: { exclude: ["@nuxt/ui"] },
    plugins: [
    vue(),
    {
      // The ui-sdk set loads no Nuxt UI. Each import of it becomes a component that fails the page when it renders.
      name: "no-nuxt-ui",
      enforce: "pre",
      resolveId: id => id.startsWith("@nuxt/ui/") ? `\0no-nuxt-ui:${id}` : undefined,
      load: id => id.startsWith("\0no-nuxt-ui:")
        ? `export default { name: "NoNuxtUI", setup() { throw new Error(${JSON.stringify(`A part rendered ${id.slice("\0no-nuxt-ui:".length)}`)}); } };`
        : undefined,
    },
  ] },
}

const browser = await chromium.launch()
const servers = []
after(async () => {
  await browser.close()
  await Promise.all(servers.map(server => server.close()))
})

for (const [set, config] of Object.entries(sets)) {
  describe(set, () => {
    /** @type {import("playwright-core").Page} */
    let page
    let navigations = 0
    const errors = []

    test("loads the page", async () => {
      const server = await createServer({
        configFile: false,
        // Nuxt UI's links warn in the console without a router. The page's own errors fail the last test.
        logLevel: "error",
        ...config,
        root: fileURLToPath(new URL(`./editor/${set}/`, import.meta.url)),
        server: { host: "127.0.0.1", port: 0 },
      })
      servers.push(server)
      await server.listen()
      const context = await browser.newContext({ viewport: { height: 900, width: 1280 } })
      page = await context.newPage()
      page.on("pageerror", error => errors.push(error.message))
      page.on("console", message => message.type() === "error" && errors.push(message.text()))
      page.on("framenavigated", frame => frame === page.mainFrame() && navigations++)
      await page.goto(server.resolvedUrls.local[0])
      // The first load can find dependencies to optimize, and Vite reloads the page for them. Settle that first.
      await page.waitForLoadState("networkidle")
      await page.locator("[data-fixture=markdown-editor] .ProseMirror").waitFor()
      await page.locator("[data-fixture=block-menu] .ProseMirror").waitFor()
      // The editor parts load on first render. Their drag handles are in the page once they have.
      await page.waitForFunction(() => document.querySelectorAll("[data-dragging]").length === 2)
      if (set === "ui-sdk") {
        const modules = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name))
        assert.deepEqual(modules.filter(name => name.includes("@nuxt/ui") || name.includes("@nuxt_ui")), [])
      }
    })

    const shot = async name => screenshots && page.screenshot({ path: join(screenshots, `${set}-${name}.png`) })
    const output = name => page.locator(`[data-output="${name}"]`).textContent()
    const editor = name => page.locator(`[data-fixture="${name}"] .ProseMirror`)
    const menu = () => page.getByRole("listbox")
    const options = () => menu().getByRole("option")
    const highlighted = () => menu().locator("[role=option][data-highlighted]").textContent()

    // Puts the caret at the end of a paragraph by its text.
    async function caretAtEnd(fixture, text) {
      await editor(fixture).getByText(text, { exact: true }).click()
      await page.keyboard.press("End")
      // ProseMirror reads the caret that End moved on the next selection change. Keys pressed before it act on the old one.
      await page.waitForFunction(([selector, text]) => {
        const { $head, empty } = document.querySelector(selector).editor.state.selection
        return empty && $head.parent.textContent === text && $head.parentOffset === text.length
      }, [`[data-fixture="${fixture}"] .ProseMirror`, text])
    }

    test("the / menu opens at the caret, filters, moves with the arrow keys, and inserts with Enter", async () => {
      await caretAtEnd("markdown-editor", "Third line")
      await page.keyboard.press("Enter")
      await page.keyboard.type("/")
      await menu().waitFor()
      await shot("slash-open")
      assert.deepEqual((await options().allTextContents()).slice(0, 3), ["Text", "Heading 1", "Heading 2"])
      assert.equal(await highlighted(), "Text")
      // The menu sits below the caret, and the caret stays in the editor.
      const caret = await page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().toJSON())
      const box = await menu().boundingBox()
      assert.ok(box.y >= caret.bottom && box.y - caret.bottom < 24, `the menu top ${box.y} is not just below the caret ${caret.bottom}`)
      assert.ok(Math.abs(box.x - caret.left) < 24, `the menu left ${box.x} is not at the caret ${caret.left}`)
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror")), true)

      await page.keyboard.type("head")
      await page.waitForFunction(() => document.querySelectorAll("[role=listbox] [role=option]").length === 3)
      assert.deepEqual(await options().allTextContents(), ["Heading 1", "Heading 2", "Heading 3"])
      await page.keyboard.press("ArrowDown")
      assert.equal(await highlighted(), "Heading 2")
      await page.keyboard.press("ArrowUp")
      await page.keyboard.press("ArrowUp")
      // ArrowUp from the first item wraps to the last.
      assert.equal(await highlighted(), "Heading 3")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await shot("slash-filtered")
      await page.keyboard.press("Enter")
      await menu().waitFor({ state: "detached" })
      await page.keyboard.type("Title")
      assert.match(await output("markdown-editor"), /\n## Title\n$/)
    })

    test("the / menu closes with Escape, and a press on an item inserts it", async () => {
      await page.keyboard.press("Enter")
      await page.keyboard.type("/quo")
      await menu().waitFor()
      await page.keyboard.press("Escape")
      await menu().waitFor({ state: "detached" })
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror")), true)
      // Typing the trigger again reopens it.
      for (let index = 0; index < 4; index++) await page.keyboard.press("Backspace")
      await page.keyboard.type("/quo")
      await menu().waitFor()
      await options().filter({ hasText: "Quote" }).hover()
      assert.equal(await highlighted(), "Quote")
      await options().filter({ hasText: "Quote" }).click()
      await menu().waitFor({ state: "detached" })
      await page.keyboard.type("Said")
      assert.match(await output("markdown-editor"), /\n> Said\n$/)
    })

    // How each set marks a pressed toolbar button: ui-sdk's toggle says it, Nuxt UI's button only looks it.
    const isPressed = async (button) => set === "ui-sdk"
      ? (await button.getAttribute("aria-pressed")) === "true"
      : (await button.getAttribute("class")).split(" ").includes("bg-primary/10")
    // The toolbar follows the editor's state a frame after it changes.
    async function pressed(button, expected) {
      for (let attempt = 0; attempt < 50 && await isPressed(button) !== expected; attempt++) await page.waitForTimeout(20)
      assert.equal(await isPressed(button), expected, `${await button.getAttribute("aria-label")} is not ${expected ? "pressed" : "released"}`)
    }

    // Selects the first word of a paragraph with the pointer.
    async function selectWord(fixture, text) {
      const box = await editor(fixture).getByText(text, { exact: true }).boundingBox()
      await page.mouse.move(box.x + 1, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 5 })
      await page.mouse.up()
    }

    test("the bubble toolbar shows on a selection, and toggles bold with its pressed state", async () => {
      await selectWord("markdown-editor", "Hello world")
      const toolbar = page.getByRole("toolbar")
      await toolbar.waitFor()
      await shot("toolbar")
      const bold = toolbar.getByRole("button", { name: "Bold" })
      await pressed(bold, false)
      await bold.click()
      await page.waitForFunction(() => document.querySelector("[data-output=markdown-editor]").textContent.startsWith("**Hello"))
      await pressed(bold, true)
      await shot("toolbar-bold")
      // The editor keeps the selection, so the next press takes bold off again.
      await bold.click()
      await page.waitForFunction(() => document.querySelector("[data-output=markdown-editor]").textContent.startsWith("Hello world"))
      await pressed(bold, false)
      // A heading button turns the block into a heading; the list buttons are disabled for none.
      await toolbar.getByRole("button", { name: "Heading 2" }).click()
      await page.waitForFunction(() => document.querySelector("[data-output=markdown-editor]").textContent.startsWith("## Hello world"))
      await pressed(toolbar.getByRole("button", { name: "Heading 2" }), true)
      // An empty selection hides it.
      await caretAtEnd("markdown-editor", "Second line")
      await toolbar.waitFor({ state: "hidden" })
    })

    test("the toolbar toggles bold from the keyboard", async () => {
      await caretAtEnd("markdown-editor", "Second line")
      await page.keyboard.press("Shift+Home")
      const toolbar = page.getByRole("toolbar")
      await toolbar.waitFor()
      const bold = toolbar.getByRole("button", { name: "Bold" })
      await bold.focus()
      await page.keyboard.press("Enter")
      await page.waitForFunction(() => document.querySelector("[data-output=markdown-editor]").textContent.includes("**Second line**"))
      await pressed(bold, true)
    })

    const handle = fixture => page.locator(`[data-fixture="${fixture}"] [data-dragging] button`).first()
    const order = async fixture => (await editor(fixture).locator(":scope > *").allTextContents())
    // Hovers a block and waits until its handle has moved beside it. Nuxt UI's handle glides there in 200ms.
    async function hoverBlock(fixture, block) {
      await block.hover()
      const target = await block.boundingBox()
      for (let attempt = 0; attempt < 50; attempt++) {
        const button = await handle(fixture).boundingBox()
        if (button && Math.abs(button.y - target.y) < 16) return { button, target }
        await page.waitForTimeout(20)
      }
      const button = await handle(fixture).boundingBox()
      assert.fail(`the handle top ${button?.y} is not beside the block top ${target.y}`)
    }

    test("the drag handle follows the pointer and drags a block to move it", async () => {
      // Without a selection, the toolbar is gone.
      await caretAtEnd("markdown-editor", "Third line")
      await page.getByRole("toolbar").waitFor({ state: "hidden" })
      const blocks = await order("markdown-editor")
      const moved = blocks.indexOf("Third line")
      const { button, target } = await hoverBlock("markdown-editor", editor("markdown-editor").locator(":scope > *").nth(moved))
      // Beside the block, on its left.
      assert.ok(button.x + button.width <= target.x, `the handle (${button.x}+${button.width}) overlaps the block at ${target.x}`)
      await shot("drag-handle")
      await handle("markdown-editor").dragTo(editor("markdown-editor").locator(":scope > *").first(), { targetPosition: { x: 10, y: 2 } })
      const expected = ["Third line", ...blocks.filter((_, index) => index !== moved)]
      await page.waitForFunction(([selector, expected]) => [...document.querySelector(selector).children].map(block => block.textContent).join("|") === expected.join("|"), ["[data-fixture=markdown-editor] .ProseMirror", expected])
    })

    test("the handle menu moves, duplicates, and deletes a block, with the pointer and the keyboard", async () => {
      assert.equal(await output("block-menu"), "# One\n\nTwo\n\nThree\n")
      await hoverBlock("block-menu", editor("block-menu").getByText("Two", { exact: true }))
      await handle("block-menu").click()
      const menuItems = page.getByRole("menu")
      await menuItems.waitFor()
      await shot("handle-menu")
      await menuItems.getByRole("menuitem", { name: "Move up" }).click()
      await page.waitForFunction(() => document.querySelector("[data-output=block-menu]").textContent === "Two\n\n# One\n\nThree\n")

      // The keyboard works the menu: arrows move, Escape closes it back to the handle, and Enter runs an item.
      await hoverBlock("block-menu", editor("block-menu").getByText("Three", { exact: true }))
      await handle("block-menu").click()
      await menuItems.getByRole("menuitem", { name: "Duplicate" }).waitFor()
      // The block is the last one, so it cannot move down.
      assert.ok(await menuItems.getByRole("menuitem", { name: "Move down" }).evaluate(element => element.hasAttribute("data-disabled")))
      await page.keyboard.press("Escape")
      await menuItems.waitFor({ state: "hidden" })
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Block actions")
      await page.keyboard.press("Enter")
      await menuItems.waitFor()
      await page.keyboard.press("Home")
      await page.waitForFunction(() => document.activeElement?.textContent?.includes("Duplicate"))
      await page.keyboard.press("Enter")
      await page.waitForFunction(() => document.querySelector("[data-output=block-menu]").textContent === "Two\n\n# One\n\nThree\n\nThree\n")

      await hoverBlock("block-menu", editor("block-menu").getByText("One", { exact: true }))
      await handle("block-menu").click()
      await menuItems.getByRole("menuitem", { name: "Delete" }).click()
      await page.waitForFunction(() => document.querySelector("[data-output=block-menu]").textContent === "Two\n\nThree\n\nThree\n")
    })

    test("the drag handle flips to stay in the viewport when the block has no room on its left", async () => {
      // The editor starts at the left edge of the window.
      await page.evaluate(() => Object.assign(document.querySelector("main").style, { margin: "0", maxWidth: "600px", padding: "48px 0" }))
      const block = editor("block-menu").locator(":scope > *").first()
      await block.hover()
      const target = await block.boundingBox()
      for (let attempt = 0; attempt < 50; attempt++) {
        const button = await handle("block-menu").boundingBox()
        if (button && button.x >= 0 && Math.abs(button.y - target.y) < 16) break
        await page.waitForTimeout(20)
      }
      const button = await handle("block-menu").boundingBox()
      await shot("drag-handle-flipped")
      assert.ok(button.x >= 0, `the handle starts at ${button.x}, outside the window`)
      assert.ok(Math.abs(button.y - target.y) < 16, `the handle top ${button.y} is not beside the block top ${target.y}`)
      await page.evaluate(() => document.querySelector("main").removeAttribute("style"))
    })

    test("throws nothing and never reloads", () => {
      assert.deepEqual(errors, [])
      assert.equal(navigations, 1)
    })
  })
}
