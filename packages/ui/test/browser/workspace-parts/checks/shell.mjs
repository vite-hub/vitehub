// WorkspaceShell layouts against sections 1 to 3 of the prototype.
import { sections, sizes } from "../prototype.mjs"

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const selectors = {
    bar: ".vh-ws-bar",
    column: ".vh-ws-column",
    guide: ".vh-ws-guide",
    guideSeparator: "[data-split=guide]",
    code: ".vh-ws-code",
    separator: "[data-split=code]",
    output: ".vh-ws-pane--output",
    editor: ".vh-ws-pane--editor",
    head: ".vh-ws-editor-head",
    tabs: ".vh-ws-tab-list",
    status: ".vh-ws-status",
  }

  for (const layout of ["side", "guide-top", "guide-side"]) {
    test(`shell ${layout}: the panes sit where the prototype has them`, async () => {
      const page = await open("shell", { layout })
      const got = await rects(page, selectors)
      near(got.bar.h, sizes.bar, "bar height")
      for (const [name, expected] of Object.entries(sections[layout])) {
        for (const side of ["x", "y", "w", "h"]) near(got[name]?.[side], expected[side], `${name}.${side}`)
      }
    })

    test(`shell ${layout}: the head rows are ${sizes.head}px and the status line is ${sizes.status}px`, async () => {
      const page = await open("shell", { layout })
      const got = await rects(page, selectors)
      near(got.head.h, sizes.head, "editor head height")
      near(got.tabs.h, sizes.head, "tab bar height")
      near(got.status.h, sizes.status, "status height")
      near(got.status.y + got.status.h, got.code.y + got.code.h, "status at the bottom of the code")
      near(got.editor.x - got.code.x, sizes.files, "files width")
      // Side by side, the bottom lines of the two head rows meet.
      if (layout === "side") near(got.head.y + got.head.h, got.tabs.y + got.tabs.h, "head bottoms")
    })
  }

  test("shell guide-side: the guide column is 360px and the output takes 40% of the right side", async () => {
    const page = await open("shell", { layout: "guide-side" })
    const got = await rects(page, { ...selectors, stack: ".vh-ws-stack" })
    near(got.guide.w, sizes.guideColumn, "guide width")
    near(got.output.h, got.stack.h * 0.4, "output height")
    near(got.code.y, got.output.y + got.output.h, "code under the output")
    near(await page.locator("[role=separator]").count(), 1, "only the files line drags")
  })

  test("shell guide-top: the guide line drags and moves with the arrow keys", async () => {
    const page = await open("shell", { layout: "guide-top" })
    const line = page.locator("[data-split=guide]")
    near(Number(await line.getAttribute("aria-valuenow")), 46, "default split")
    await line.focus()
    await page.keyboard.press("ArrowDown")
    near(Number(await line.getAttribute("aria-valuenow")), 51, "after ArrowDown")
    const box = await line.boundingBox()
    const column = (await rects(page, selectors)).column
    await page.mouse.move(box.x + 100, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + 100, column.y + column.h * 0.3, { steps: 4 })
    await page.mouse.up()
    near(Number(await line.getAttribute("aria-valuenow")), 30, "after a drag to 30%")
    near((await rects(page, selectors)).guide.h, column.h * 0.3, "guide height after the drag")
  })

  test("shell side: a menu that opens in a portal covers the separators", async () => {
    const page = await open("shell", { layout: "side" })
    const line = await page.locator("[data-split=code]").boundingBox()
    const point = { x: line.x + line.width / 2, y: line.y + line.height / 2 }
    const top = await page.evaluate(({ x, y }) => {
      const menu = Object.assign(document.createElement("div"), { id: "portal-menu" })
      Object.assign(menu.style, { height: "40px", left: `${x - 20}px`, position: "fixed", top: `${y - 20}px`, width: "40px" })
      document.body.append(menu)
      return document.elementFromPoint(x, y)?.id
    }, point)
    if (top !== "portal-menu") throw new Error(`the separator paints over a menu in a portal: ${top}`)
  })

  test("shell guide-top: the code column fills the shell without output", async () => {
    const page = await open("shell", { layout: "guide-top", "no-output": "" })
    const got = await rects(page, { ...selectors, body: ".vh-ws-body" })
    near(got.column.w, got.body.w, "full-width guide and code column")
  })

  for (const [layout, width] of [["side", 768], ["guide-top", 1024], ["guide-side", 520]]) {
    test(`shell ${layout}: the editor keeps room at ${width}px`, async () => {
      const page = await open("shell", { layout, persist: "" })
      const divider = page.locator("[data-split=files]")
      if (layout !== "guide-side") {
        if (layout === "guide-top") await page.locator("[data-split=code]").press("Home")
        await divider.press("End")
      }
      await page.locator(".vh-ws-shell").evaluate((element, width) => { element.style.width = `${width}px` }, width)
      const check = async () => {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const got = await rects(page, selectors)
        near(Math.min(got.editor.w, 120), 120, "editor width of at least 120px")
      }
      await check()
      await page.goto(`${page.url()}&width=${width}px`)
      await page.locator("html[data-ready]").waitFor({ state: "attached" })
      await check()

      const code = (await rects(page, selectors)).code
      const line = await divider.boundingBox()
      await page.mouse.move(line.x, line.y + 10)
      await page.mouse.down()
      await page.mouse.move(code.x + code.w - 5, line.y + 10)
      await page.mouse.up()
      await check()
    })
  }
}
