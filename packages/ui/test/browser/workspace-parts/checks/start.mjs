// WorkspaceStart against section 4 of the prototype, `v-playground-start-screen`: five examples and Empty would make
// two rows of three. The fixture has the five examples of section 1, so the second row has two cards.
const section4 = {
  start: { x: 0, y: 44, w: 1280, h: 716 },
  title: { x: 260, w: 760, h: 31.89 },
  description: { x: 260, h: 20.3 },
  first: { x: 260, w: 246.66 },
  second: { x: 516.66, w: 246.67 },
  fourth: { x: 260 },
}

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const selectors = {
    start: ".vh-ws-start",
    content: ".vh-ws-start-content",
    title: ".vh-ws-start-title",
    description: ".vh-ws-start-description",
    grid: ".vh-ws-start-grid",
    first: ".vh-ws-start-grid > li:nth-child(1) .vh-ws-start-card",
    second: ".vh-ws-start-grid > li:nth-child(2) .vh-ws-start-card",
    fourth: ".vh-ws-start-grid > li:nth-child(4) .vh-ws-start-card",
    foot: ".vh-ws-start-foot",
  }

  for (const theme of ["light", "dark"]) {
    test(`start ${theme}: the cards sit in three columns of a 760px block, as in the prototype`, async () => {
      const page = await open("bar", { theme, start: "1" })
      const got = await rects(page, selectors)
      for (const [name, rect] of Object.entries(section4)) {
        for (const [side, value] of Object.entries(rect)) near(got[name]?.[side], value, `${name}.${side}`)
      }
      // The spacing of the prototype: 4px under the title, 20px under the text, 10px between cards, 18px over the foot.
      near(got.description.y - (got.title.y + got.title.h), 4, "title gap")
      near(got.grid.y - (got.description.y + got.description.h), 20, "text gap")
      near(got.second.x - (got.first.x + got.first.w), 10, "column gap")
      near(got.fourth.y - (got.first.y + got.first.h), 10, "row gap")
      near(got.foot.y - (got.grid.y + got.grid.h), 18, "foot gap")
      near(got.content.y + got.content.h / 2, 44 + 716 / 2, "centered under the bar")
    })
  }

  test("start: a pick opens the example and closes the screen", async () => {
    const page = await open("bar", { start: "1" })
    await page.getByRole("button", { name: /^Plurals/ }).click()
    await page.locator(".vh-ws-start").waitFor({ state: "detached" })
    await page.locator("[data-example=plurals]").waitFor()
  })
}
