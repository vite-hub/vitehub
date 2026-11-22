// The code parts (file tree, editor head, editor, status) against sections 5 and 1 of the prototype. The numbers are
// rects measured in Chromium from the prototype at 1280x760, in CSS pixels from the top left of the section.
import { sizes } from "../prototype.mjs"

/** Section 5 (`v-playground-render-gpu-engine`, wrap on) and section 1 (`v-playground-examples-menu`, wrap off). */
const sections = {
  gpu: {
    open: "name-tagger.model.ts",
    edited: "data/train.jsonl",
    nested: "data/dev.jsonl",
    openRowY: 142,
    breadcrumbIconX: 212,
    breadcrumbNameX: 233,
    firstLineH: 41.25,
    language: "TypeScript",
  },
  glosa: {
    open: "src/components/Greeting.vue",
    edited: "locales/es.json",
    nested: "locales/de.json",
    openRowY: 186,
    // The Vue logo is 14px in a 16px box, at x 338 in the prototype.
    breadcrumbIconX: 337,
    breadcrumbNameX: 358,
    firstLineH: 20.63,
    language: "Vue",
  },
}

const both = {
  head: { x: 200, y: 44, w: 440, h: sizes.head },
  wrap: { x: 610, y: 47.5, w: 24, h: 24 },
  wrapIcon: { x: 614.5, y: 52, w: 15, h: 15 },
  status: { x: 200, y: 736, w: 440, h: sizes.status },
  // Rows are 22px from under the 32px files head, and 199px wide next to the 1px line.
  row: { x: 0, h: 22, w: 199, firstY: 76 },
  // A file one level down: its icon and its name.
  nestedIcon: { x: 38, w: 16 },
  nestedNameX: 58,
  // The dot of an edited file: 6px, 8px from the end of the row.
  dot: { x: 185, w: 6, h: 6 },
  // The line numbers are 28px with 16px after them, so the code starts at 244.
  gutterW: 44,
  codeX: 244,
  firstLineY: 84,
}

/** Rects inside the shadow DOM of the tree, by path. */
async function treeRects(page, paths) {
  await page.waitForFunction(() => document.querySelector(".vh-ws-file-tree")?.shadowRoot?.querySelector('[data-type="item"]'))
  return page.evaluate((paths) => {
    const root = document.querySelector(".vh-ws-file-tree")?.shadowRoot
    if (!root) throw new Error("The file tree has no shadow root.")
    const rect = (element) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, w: box.width, h: box.height }
    }
    const rows = [...root.querySelectorAll('[data-type="item"]')]
    return {
      rows: rows.map(row => ({ path: row.dataset.itemPath, ...rect(row) })),
      ...Object.fromEntries(Object.entries(paths).map(([name, path]) => {
        const row = root.querySelector(`[data-type="item"][data-item-path="${path}"]`)
        const content = row?.querySelector('[data-item-section="content"]')
        const text = content && document.createRange()
        text?.selectNodeContents(content)
        return [name, {
          row: rect(row),
          icon: rect(row?.querySelector('[data-item-section="icon"] svg')),
          name: text ? rect(text) : null,
          dot: rect(row?.querySelector('[data-item-git-status="modified"] > [data-item-section="git"] > span')),
          shadow: row ? getComputedStyle(row).boxShadow : "",
        }]
      })),
    }
  }, paths)
}

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const selectors = {
    head: ".vh-ws-editor-head",
    wrap: ".vh-ws-wrap-button",
    wrapIcon: ".vh-ws-wrap-button svg",
    breadcrumbIcon: ".vh-ws-breadcrumb .vh-ws-file-icon",
    breadcrumbName: ".vh-ws-breadcrumb b",
    breadcrumbSeparator: ".vh-ws-breadcrumb-separator:has(+ .vh-ws-file-icon)",
    gutter: ".cm-gutters",
    line: ".cm-line",
    status: ".vh-ws-status",
    statusFirst: ".vh-ws-status-items span",
  }

  for (const [section, expected] of Object.entries(sections)) for (const theme of ["light", "dark"]) {
    test(`code parts ${section} ${theme}: the editor head, the editor and the status line sit where the prototype has them`, async () => {
      const page = await open("code-parts", { section, theme })
      const got = await rects(page, selectors)
      for (const name of ["head", "wrap", "wrapIcon", "status"]) {
        for (const side of ["x", "y", "w", "h"]) near(got[name][side], both[name][side], `${name}.${side}`)
      }
      // Folder names take the width of the font, which differs between machines. So the icon is checked against the
      // end of the last folder separator, and the name against the icon.
      if (expected.open.includes("/")) {
        if (!got.breadcrumbSeparator) throw new Error("Missing separator before the breadcrumb file icon.")
        near(got.breadcrumbIcon.x - got.breadcrumbSeparator.x - got.breadcrumbSeparator.w, 2, "breadcrumb icon after the separator")
      }
      else near(got.breadcrumbIcon.x, expected.breadcrumbIconX, "breadcrumb icon x", 2)
      near(got.breadcrumbName.x - got.breadcrumbIcon.x, expected.breadcrumbNameX - expected.breadcrumbIconX, "breadcrumb name after the icon")
      near(got.gutter.w, both.gutterW, "gutter width")
      near(got.line.x, both.codeX, "code x")
      near(got.line.y, both.firstLineY, "first line y")
      near(got.line.h, expected.firstLineH, "first line height")
      near(got.statusFirst.x, 212, "status text x")
      const status = await page.locator(".vh-ws-status").innerText()
      if (!/Ln 1, Col 1/.test(status) || !status.includes(expected.language) || !status.includes("Spaces: 2") || /Wrap/.test(status)) {
        throw new Error(`The status line reads "${status}".`)
      }
    })

    test(`code parts ${section} ${theme}: the tree rows, icons and edited dot sit where the prototype has them`, async () => {
      const page = await open("code-parts", { section, theme, edited: "1" })
      const got = await treeRects(page, { open: expected.open, edited: expected.edited, nested: expected.nested })
      near(got.rows[0].y, both.row.firstY, "first row y")
      for (const row of got.rows) {
        near(row.x, both.row.x, `${row.path} x`)
        near(row.w, both.row.w, `${row.path} width`)
        near(row.h, both.row.h, `${row.path} height`)
      }
      near(got.open.row.y, expected.openRowY, "open file row y")
      if (!got.open.shadow.includes("inset")) throw new Error(`The open file row has no accent line: "${got.open.shadow}".`)
      near(got.nested.icon.x, both.nestedIcon.x, "nested icon x")
      near(got.nested.icon.w, both.nestedIcon.w, "nested icon width")
      near(got.nested.name.x, both.nestedNameX, "nested name x")
      if (got.nested.dot) throw new Error("A file that is not edited has a dot.")
      for (const side of ["x", "w", "h"]) near(got.edited.dot?.[side], both.dot[side], `dot.${side}`)
      near(got.edited.dot.y + got.edited.dot.h / 2, got.edited.row.y + got.edited.row.h / 2, "dot centered in its row")
    })
  }

  test("code parts: at the narrowest code split the file name and the status line fit", async () => {
    const page = await open("code-parts", { section: "glosa" })
    await page.locator("[data-split=code]").press("Home")
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const got = await page.evaluate(() => {
      const box = element => element.getBoundingClientRect()
      const name = document.querySelector(".vh-ws-breadcrumb b")
      const status = box(document.querySelector(".vh-ws-status"))
      return {
        name: { clipped: name.scrollWidth > name.clientWidth, w: box(name).width },
        folders: [...document.querySelectorAll(".vh-ws-breadcrumb > span, .vh-ws-breadcrumb-separator")].reduce((sum, item) => sum + box(item).width, 0),
        nav: box(document.querySelector(".vh-ws-breadcrumb")),
        nameBox: box(name),
        status: { left: status.left, right: status.right },
        items: [...document.querySelectorAll(".vh-ws-status-items > span")].map(item => ({ left: box(item).left, right: box(item).right, text: item.textContent })),
        cursor: (() => { const item = document.querySelector(".vh-ws-status-cursor"); return item.scrollWidth <= item.clientWidth })(),
      }
    })
    // The name ends with an ellipsis only when the folders gave all their room to it.
    if (got.name.w < 30 || (got.name.clipped && got.folders > 0.5)) throw new Error(`The file name is ${got.name.w}px, clipped: ${got.name.clipped}, with ${got.folders}px of folders.`)
    if (got.nameBox.right > got.nav.right + 0.5) throw new Error("The file name ends past the breadcrumb.")
    for (const item of got.items) {
      if (item.right > got.status.right + 0.5) throw new Error(`"${item.text}" ends at ${item.right}, past the status line at ${got.status.right}.`)
    }
    if (!got.cursor) throw new Error("The cursor position is shortened.")
  })

  test("code parts: Alt+Z and the wrap button toggle line wrapping", async () => {
    const page = await open("code-parts", { section: "gpu" })
    const state = async () => ({
      pressed: await page.locator(".vh-ws-wrap-button").getAttribute("aria-pressed"),
      height: (await rects(page, { line: ".cm-line" })).line.h,
    })
    let got = await state()
    if (got.pressed !== "true") throw new Error(`The wrap button starts with aria-pressed="${got.pressed}".`)
    near(got.height, sections.gpu.firstLineH, "wrapped first line height")

    await page.locator(".cm-content").click()
    await page.keyboard.press("Alt+z")
    got = await state()
    if (got.pressed !== "false") throw new Error(`After Alt+Z the wrap button has aria-pressed="${got.pressed}".`)
    near(got.height, sections.glosa.firstLineH, "unwrapped first line height")

    await page.locator(".vh-ws-wrap-button").click()
    got = await state()
    if (got.pressed !== "true") throw new Error(`After a click the wrap button has aria-pressed="${got.pressed}".`)
    near(got.height, sections.gpu.firstLineH, "wrapped again first line height")
  })
}
