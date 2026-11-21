// Workspace against sections 1 to 5 of the prototype: the composed parts keep the rects that the bar, shell, guide,
// start and code-parts checks measure on each part alone.
import assert from "node:assert/strict"

import { sections, sizes } from "../prototype.mjs"

/** Section 1, `v-playground-examples-menu`, at 1280x760 with the sidebar open. */
const section1 = {
  toggle: { x: 8, y: 6.5, w: 30, h: 30 },
  examples: { x: 40, y: 6.5, h: 30 },
  more: { x: 1242, y: 6.5, w: 30, h: 30 },
  sidebar: { x: 0, y: 44, w: 264, h: 716 },
}
/** Section 4, `v-playground-start-screen`: five examples make a row of three and a row of two. */
const section4 = {
  start: { x: 0, y: 44, w: 1280, h: 716 },
  title: { x: 260, w: 760, h: 31.89 },
  first: { x: 260, w: 246.66 },
  second: { x: 516.66, w: 246.67 },
  fourth: { x: 260 },
}

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const check = (got, expected) => {
    for (const [name, rect] of Object.entries(expected)) {
      for (const [side, value] of Object.entries(rect)) near(got[name]?.[side], value, `${name}.${side}`)
    }
  }
  const shell = {
    bar: ".vh-ws-bar",
    column: ".vh-ws-column",
    guide: ".vh-ws-guide",
    guideSeparator: "[data-split=guide]",
    code: ".vh-ws-code",
    separator: "[data-split=code]",
    output: ".vh-ws-pane--output",
    editor: ".vh-ws-pane--editor",
    head: ".vh-ws-editor-head",
    files: ".vh-ws-pane--files .vh-ws-head",
    tabs: ".vh-ws-tab-list",
    status: ".vh-ws-status",
  }
  const rows = (got, layout) => {
    near(got.bar.h, sizes.bar, "bar height")
    near(got.head.h, sizes.head, "editor head height")
    near(got.files.h, sizes.head, "files head height")
    near(got.tabs.h, sizes.head, "tab bar height")
    near(got.status.h, sizes.status, "status height")
    near(got.status.y + got.status.h, got.code.y + got.code.h, "status at the bottom of the code")
    near(got.editor.x - got.code.x, sizes.files, "files width")
    near(got.files.y + got.files.h, got.head.y + got.head.h, "files and editor head bottoms")
    if (layout === "side") near(got.head.y + got.head.h, got.tabs.y + got.tabs.h, "head bottoms")
  }

  for (const theme of ["light", "dark"]) {
    test(`Workspace section 1 ${theme}: the bar, the panes and the head rows sit where the prototype has them`, async () => {
      const page = await open("workspace", { section: "1", theme })
      const got = await rects(page, {
        ...shell,
        toggle: ".vh-ws-topbar [aria-controls=vh-workspace-sidebar]",
        examples: ".vh-ws-examples-button",
        more: ".vh-ws-topbar [aria-label='More actions']",
      })
      check(got, { toggle: section1.toggle, examples: section1.examples, more: section1.more })
      check(got, sections.side)
      rows(got, "side")
    })
  }

  test("Workspace section 1: the sidebar is 264px under the bar, with Reset, Download and Copy link at its bottom", async () => {
    const page = await open("workspace", { section: "1" })
    await page.locator(".vh-ws-topbar [aria-controls=vh-workspace-sidebar]").click()
    const got = await rects(page, { sidebar: ".vh-ws-sidebar", code: ".vh-ws-code", link: ".vh-ws-sidebar-link", footer: ".vh-ws-sidebar-footer" })
    check(got, { sidebar: section1.sidebar })
    near(got.code.x, 0, "the code stays at the start")
    near(got.footer.y + got.footer.h, 760, "the actions sit at the bottom")
    assert.deepEqual(await page.locator(".vh-ws-sidebar-footer button").allInnerTexts(), ["Reset", "Download", "Copy link"])
    assert.equal(await page.locator(".vh-ws-topbar").getByRole("button", { name: "Copy link" }).count(), 0, "the bar does not repeat them")
  })

  for (const [section, layout] of [["2", "guide-top"], ["3", "guide-side"]]) {
    test(`Workspace section ${section}: the guide, the panes and the head rows sit as in ${layout}`, async () => {
      const page = await open("workspace", { section })
      const got = await rects(page, {
        ...shell,
        pane: ".vh-ws-guide-pane",
        footer: ".vh-ws-guide-footer",
        steps: ".vh-ws-step-nav",
      })
      check(got, sections[layout])
      rows(got, layout)
      for (const side of ["x", "y", "w", "h"]) near(got.pane[side], got.guide[side], `pane.${side}`)
      near(got.footer.y + got.footer.h, got.guide.y + got.guide.h, "Back and Next at the guide bottom")
      near(got.steps.y + got.steps.h / 2, got.bar.y + got.bar.h / 2, "steps centered in the bar")
      assert.equal(await page.locator(".vh-ws-step-nav-name").textContent(), "2. Translate it")
    })
  }

  test("Workspace section 4: the start cards sit in three columns of a 760px block", async () => {
    const page = await open("workspace", { section: "4" })
    const got = await rects(page, {
      start: ".vh-ws-start",
      title: ".vh-ws-start-title",
      first: ".vh-ws-start-grid > li:nth-child(1) .vh-ws-start-card",
      second: ".vh-ws-start-grid > li:nth-child(2) .vh-ws-start-card",
      fourth: ".vh-ws-start-grid > li:nth-child(4) .vh-ws-start-card",
    })
    check(got, section4)
  })

  test("Workspace section 4: Tab never reaches the editor, the files or the bar under the start screen", async () => {
    const page = await open("workspace", { section: "4" })
    // The editor mounts under the screen, so its content is there to take focus if the cover lets it.
    await page.locator(".vh-ws-editor .cm-content").waitFor({ state: "attached" })
    const reached = []
    for (let index = 0; index < 24; index++) {
      await page.keyboard.press("Tab")
      reached.push(await page.evaluate(() => {
        const element = document.activeElement
        if (!element || element === document.body) return "body"
        if (element.closest(".cm-content, .vh-ws-file-tree, .vh-ws-body, .vh-ws-topbar")) return `covered: ${element.className || element.localName}`
        return element.closest(".vh-ws-start") ? "start" : `other: ${element.className || element.localName}`
      }))
    }
    assert.deepEqual(reached.filter(entry => entry.startsWith("covered")), [])
    assert.ok(reached.includes("start"), `Tab reached no start card: ${reached.join(", ")}`)
    await page.getByRole("button", { name: /^Plurals/ }).click()
    await page.locator(".vh-ws-start").waitFor({ state: "detached" })
    await page.locator(".vh-ws-editor .cm-content").click()
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest(".cm-content")), "the editor takes focus after a pick")
  })

  test("Workspace section 5: render() fills the output pane with its frame, beside the code", async () => {
    const page = await open("workspace", { section: "5" })
    await page.locator("iframe.vh-workspace-frame").waitFor()
    const got = await rects(page, { ...shell, frame: "iframe.vh-workspace-frame", panel: "[data-tab=output]" })
    check(got, sections.side)
    rows(got, "side")
    for (const side of ["x", "y", "w", "h"]) near(got.frame[side], got.panel[side], `frame.${side}`)
    assert.deepEqual(await page.getByRole("tab").allInnerTexts(), ["Output", "Issues"])
    assert.match(await page.locator(".vh-workspace-run-state").innerText(), /Rendered/)
  })
}
