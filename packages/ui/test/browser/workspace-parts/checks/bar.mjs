import { sizes } from "../prototype.mjs"

const section1 = {
  toggle: { x: 8, y: 6.5, w: 30, h: 30 },
  examples: { x: 40, y: 6.5, h: 30 },
  more: { x: 1242, y: 6.5, w: 30, h: 30 },
  menu: { x: 40, y: 42.5, w: 340 },
  heading: { x: 54, y: 56.5, h: 16.67 },
  item: { x: 46, y: 77.17, w: 328, h: 50.69 },
  sidebar: { x: 0, y: 44, w: 264, h: 716 },
}

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const check = (got, expected) => {
    for (const [name, rect] of Object.entries(expected)) {
      for (const [side, value] of Object.entries(rect)) near(got[name]?.[side], value, `${name}.${side}`)
    }
  }
  const bar = {
    bar: ".vh-ws-bar",
    toggle: ".vh-ws-topbar [aria-controls=sidebar]",
    examples: ".vh-ws-examples-button",
    more: ".vh-ws-topbar [aria-label='More actions']",
    copy: ".vh-ws-topbar > [data-slot=button]:nth-last-child(2)",
  }

  for (const theme of ["light", "dark"]) {
    test(`bar ${theme}: the bar is ${sizes.bar}px with 30px buttons where the prototype has them`, async () => {
      const page = await open("bar", { theme })
      const got = await rects(page, bar)
      near(got.bar.h, sizes.bar, "bar height")
      check(got, { toggle: section1.toggle, examples: section1.examples, more: section1.more })
      near(got.copy.x + got.copy.w, section1.more.x - 2, "Copy link ends 2px before More")
      near(got.copy.h, 30, "Copy link height")
    })

    test(`bar ${theme}: the examples menu is 340px with group headings and two-line items`, async () => {
      const page = await open("bar", { theme })
      await page.locator(bar.examples).click()
      await page.getByRole("menu").waitFor()
      const got = await rects(page, {
        menu: ".vh-ws-examples-menu",
        heading: ".vh-ws-examples-menu [data-slot=menu-group-label]",
        item: ".vh-ws-examples-menu [role=menuitemcheckbox]",
      })
      check(got, { menu: section1.menu, heading: section1.heading, item: section1.item })
      const checked = await page.locator(".vh-ws-examples-menu [aria-checked=true]").allTextContents()
      if (checked.length !== 1 || !checked[0].startsWith("Vue")) throw new Error(`the open example is not checked: ${checked}`)
    })

    test(`bar ${theme}: the sidebar is 264px under the bar and does not push the workspace`, async () => {
      const page = await open("bar", { theme, sidebar: "open" })
      const got = await rects(page, { sidebar: ".vh-ws-sidebar", code: ".vh-ws-code", link: ".vh-ws-sidebar-link", footer: ".vh-ws-sidebar-footer" })
      check(got, { sidebar: section1.sidebar })
      near(got.code.x, 0, "the code stays at the start")
      near(got.link.x, 8, "link x")
      near(got.link.w, 248, "link width")
      near(got.footer.y + got.footer.h, 760, "the actions sit at the bottom")
    })
  }
}
