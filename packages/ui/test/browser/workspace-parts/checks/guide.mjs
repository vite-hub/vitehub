// WorkspaceGuide, WorkspaceSteps, WorkspaceTask, and WorkspaceFileLink in the shell, against sections 2 and 3 of the
// prototype. Two numbers differ from it on purpose: Maxi asked for a bigger step title (comment 13) and for Back and
// Next at the bottom of the guide column, not under the text (comment 12).
import assert from "node:assert/strict"

import { sections, sizes } from "../prototype.mjs"

/** The guide of the prototype (`.guide` in `parts/v4.css`), with the bigger title. */
const guide = { padTop: 18, padX: 22, kicker: 12, title: 20, prototypeTitle: 17, text: 62 }

/** @param {import("../../workspace-parts.browser.mjs").Harness} harness */
export default function ({ test, open, rects, near }) {
  const selectors = {
    bar: ".vh-ws-bar",
    guide: ".vh-ws-guide",
    pane: ".vh-ws-guide-pane",
    kicker: ".vh-ws-guide-kicker",
    title: ".vh-ws-guide-title",
    footer: ".vh-ws-guide-footer",
    back: ".vh-ws-guide-back",
    next: ".vh-ws-guide-next",
    steps: ".vh-ws-step-nav",
    menu: ".vh-ws-step-nav-menu",
    task: ".vh-ws-task",
    link: ".vh-ws-file-link",
  }

  for (const layout of ["guide-top", "guide-side"]) {
    test(`guide ${layout}: the guide fills its pane, the title is bigger, and Back and Next sit at the bottom`, async () => {
      const page = await open("guide", { layout })
      const got = await rects(page, selectors)
      for (const side of ["x", "y", "w", "h"]) {
        near(got.guide[side], sections[layout].guide[side], `guide.${side}`)
        near(got.pane[side], got.guide[side], `pane.${side}`)
      }
      near(got.kicker.y, got.guide.y + guide.padTop, "kicker at the top padding")
      near(got.title.x, got.guide.x + guide.padX, "title at the side padding")
      const title = await page.locator(selectors.title).evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
      near(title, guide.title, "title size")
      assert.ok(title > guide.prototypeTitle, `title size ${title}px is not bigger than the prototype's ${guide.prototypeTitle}px`)
      near(got.footer.y + got.footer.h, got.guide.y + got.guide.h, "footer bottom at the guide bottom")
      near(got.footer.x, got.guide.x, "footer x")
      near(got.footer.w, got.guide.w, "footer width")
      near(got.back.x, got.guide.x + guide.padX, "Back at the left padding")
      near(got.next.x + got.next.w, got.guide.x + got.guide.w - guide.padX, "Next at the right padding")
    })
  }

  test("guide: the steps menu, the count, and the arrows sit in the bar", async () => {
    const page = await open("guide", { layout: "guide-top" })
    const got = await rects(page, selectors)
    near(got.bar.h, sizes.bar, "bar height")
    near(got.steps.y + got.steps.h / 2, got.bar.y + got.bar.h / 2, "steps centered in the bar")
    assert.equal(await page.locator(".vh-ws-step-nav-name").textContent(), "2. Translate it", "menu label")
    const count = page.locator(".vh-ws-step-nav-count")
    near(await count.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)), 12.5, "count size", 0.01)
    assert.equal(await count.textContent(), "Step 2 of 4", "count text")
  })

  test("guide: the task box and the file link use the prototype styles", async () => {
    const page = await open("guide", { layout: "guide-side" })
    const task = await page.locator(selectors.task).evaluate((element) => {
      const style = getComputedStyle(element)
      return { radius: Number.parseFloat(style.borderTopLeftRadius), top: Number.parseFloat(style.paddingTop), left: Number.parseFloat(style.paddingLeft) }
    })
    near(task.radius, 8, "task radius")
    near(task.top, 10, "task padding top")
    near(task.left, 12, "task padding left")
    const link = await page.locator(selectors.link).evaluate((element) => {
      const style = getComputedStyle(element)
      const probe = document.createElement("span")
      probe.style.color = "var(--ring)"
      document.body.append(probe)
      const ring = getComputedStyle(probe).color
      probe.remove()
      return { color: style.color, ring, size: Number.parseFloat(style.fontSize), text: element.textContent, underline: style.textDecorationLine }
    })
    near(link.size, 12, "file link size")
    assert.equal(link.color, link.ring, "file link in the accent color")
    assert.equal(link.underline, "underline", "file link underline")
    assert.equal(link.text, "es.json", "file link shows the file name")
  })

  test("guide: Next in the footer moves the bar too, and a file link opens its file", async () => {
    const page = await open("guide", { layout: "guide-side" })
    await page.locator(selectors.next).click()
    assert.equal(await page.locator(".vh-ws-step-nav-count").textContent(), "Step 3 of 4", "bar count after Next")
    assert.equal(await page.locator(selectors.title).textContent(), "Plurals", "guide title after Next")
    await page.locator("[aria-label='Previous step']").click()
    await page.locator("[aria-label='Previous step']").click()
    assert.equal(await page.locator(selectors.back).count(), 0, "no Back on the first step")
    await page.locator(selectors.next).click()
    await page.locator(selectors.next).click()
    assert.equal(await page.locator("[data-file]").textContent(), "src/components/Inbox.vue", "editor head on the Plurals step")
    await page.locator(selectors.link).click()
    assert.equal(await page.locator("[data-file]").textContent(), "locales/es.json", "editor head after the link")
  })

  for (const layout of ["guide-top", "guide-side"]) {
    test(`guide ${layout} dark: the parts render on the dark tokens`, async () => {
      const page = await open("guide", { layout, theme: "dark" })
      const dark = await page.locator(selectors.title).evaluate(element => getComputedStyle(element).color)
      const light = await (await open("guide", { layout })).locator(selectors.title).evaluate(element => getComputedStyle(element).color)
      assert.notEqual(dark, light, "the title takes the dark color")
    })
  }
}
