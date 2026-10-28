// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"

import { createAnchor, labelOf, placeAnchor, selectorOf } from "../src/anchor.ts"

/** happy-dom has no layout: give each element the box in its `data-box` attribute (`left top width height`). */
function layout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const [left = 0, top = 0, width = 0, height = 0] = (this.getAttribute("data-box") ?? "").split(" ").map(Number)
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
  }
}

beforeEach(() => {
  layout()
  document.body.innerHTML = `
    <main>
      <section><h2 data-box="0 0 100 20">Plans</h2><p data-box="0 20 200 40">Pick one</p></section>
      <section><h2 data-box="0 100 100 20" data-content-field="pricing#hero.title">Simple pricing</h2><p data-box="0 120 200 40">For teams</p></section>
      <div id="faq"><p data-box="0 300 400 100">Questions</p></div>
    </main>`
})

describe("anchors", () => {
  it("names elements by a positional path that stops at an id or a Content field", () => {
    const paragraphs = document.querySelectorAll("p")
    expect(selectorOf(paragraphs[0]!)).toBe("body > main > section:nth-of-type(1) > p")
    expect(selectorOf(paragraphs[2]!)).toBe("#faq > p")
    expect(selectorOf(document.querySelector("h2[data-content-field]")!)).toBe("[data-content-field=\"pricing#hero.title\"]")
    expect(labelOf(paragraphs[1]!)).toBe("p For teams")
  })

  it("records the Content field and the point in thousandths of the element box", () => {
    const heading = document.querySelector("h2[data-content-field]")!
    const anchor = createAnchor(heading, 25, 110)
    expect(anchor).toMatchObject({ field: "pricing#hero.title", label: "h2 Simple pricing", x: 250, y: 500 })
  })

  it("follows the element when the layout moves", () => {
    const paragraph = document.querySelectorAll("p")[1]!
    const anchor = createAnchor(paragraph, 100, 140)
    paragraph.setAttribute("data-box", "50 500 400 80")
    expect(placeAnchor(anchor)).toMatchObject({ state: "exact", x: 250, y: 540 })
  })

  it("keeps a Content field pin when the page is rebuilt around it and its text changes", () => {
    const anchor = createAnchor(document.querySelector("h2[data-content-field]")!, 50, 110)
    document.body.innerHTML = `<header><div><h1 data-box="10 10 300 50" data-content-field="pricing#hero.title">Pricing for everyone</h1></div></header>`
    expect(placeAnchor(anchor)).toMatchObject({ state: "exact", x: 160, y: 35 })
  })

  it("finds an element by its label when its path changed", () => {
    const anchor = createAnchor(document.querySelectorAll("p")[1]!, 100, 140)
    document.body.innerHTML = `<article><p data-box="0 0 10 10">New intro</p><p data-box="0 50 200 40">For teams</p></article>`
    expect(placeAnchor(anchor)).toMatchObject({ state: "exact", x: 100, y: 70 })
  })

  it("does not pin to a different element at the same path", () => {
    const anchor = createAnchor(document.querySelectorAll("p")[0]!, 100, 40)
    document.querySelectorAll("p")[0]!.textContent = "Something else"
    expect(placeAnchor(anchor).state).toBe("moved")
  })

  it("hides the pin while its element has no box", () => {
    const anchor = createAnchor(document.querySelectorAll("p")[0]!, 100, 40)
    document.querySelectorAll("p")[0]!.removeAttribute("data-box")
    expect(placeAnchor(anchor).state).toBe("hidden")
  })
})
