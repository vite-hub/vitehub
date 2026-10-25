import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAnchor, resolveAnchor, type ResolvedAnchor } from "../src/client.ts"

interface Box { left: number, top: number, width: number, height: number }

// happy-dom has no layout, so each test says where an element is.
const boxes = new WeakMap<Element, Box>()
function place(element: Element, box: Box): void {
  boxes.set(element, box)
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function page(html: string): void {
  document.body.innerHTML = html
}

function resolved(position: ReturnType<typeof resolveAnchor>): ResolvedAnchor {
  if (position.detached) throw new Error("The anchor is detached.")
  return position
}

describe("createAnchor selectors", () => {
  it("prefers data-comment-id, then id, then data-testid", () => {
    page(`<div id="a" data-testid="t" data-comment-id="c"></div><div id="b" data-testid="u"></div><div data-testid="v"></div>`)
    const [first, second, third] = [...document.body.children]
    expect(createAnchor(first!)).toMatchObject({ kind: "element", selector: `[data-comment-id="c"]` })
    expect(createAnchor(second!)).toMatchObject({ selector: "#b" })
    expect(createAnchor(third!)).toMatchObject({ selector: `[data-testid="v"]` })
  })

  it("skips a stable attribute that is not unique", () => {
    page(`<ul><li id="x">One</li><li id="x">Two</li></ul>`)
    const second = document.querySelectorAll("li")[1]!
    const anchor = createAnchor(second)
    expect(anchor).toMatchObject({ selector: expect.stringContaining("nth-of-type(2)") })
    expect(document.querySelector(anchor.kind === "element" ? anchor.selector : "")).toBe(second)
  })

  it("builds a short structural path from the nearest stable ancestor", () => {
    page(`<main><div><p>A</p><p>B</p></div><section id="plans"><div><p>A</p><p>B</p></div></section></main>`)
    const second = document.querySelectorAll("p")[3]!
    expect(createAnchor(second)).toMatchObject({ selector: "#plans > div > p:nth-of-type(2)" })
  })

  it.each([":r1:", "«r2»", "_r_3_", "radix-:r4:-trigger", "headlessui-menu-button-5", "v-1", "data-v-7ba5bd90", "3f9c2e1b7a4d", "12345678", "ember123"])(
    "does not use the generated id %s",
    (id) => {
      page(`<section><div id="${id}"><p>A</p><p>B</p></div></section>`)
      const second = document.querySelectorAll("p")[1]!
      const anchor = createAnchor(second)
      expect(anchor).toMatchObject({ selector: "p:nth-of-type(2)" })
      expect(JSON.stringify(anchor)).not.toContain(id)
      expect(createAnchor(document.getElementById(id)!)).toMatchObject({ selector: "div" })
    },
  )

  it("still uses an id that a person chose", () => {
    page(`<div id="pricing-table"><p>A</p></div>`)
    expect(createAnchor(document.querySelector("p")!)).toMatchObject({ selector: "p" })
    expect(createAnchor(document.getElementById("pricing-table")!)).toMatchObject({ selector: "#pricing-table" })
  })

  it("stops the path as soon as it is unique", () => {
    page(`<main><nav><a href="/">Home</a></nav><footer><small>Hi</small></footer></main>`)
    expect(createAnchor(document.querySelector("small")!)).toMatchObject({ selector: "small" })
  })
})

describe("anchor round trips", () => {
  it("stores offsets in thousandths of the element box and finds the same point again", () => {
    page(`<div id="card"></div>`)
    const card = document.getElementById("card")!
    place(card, { left: 100, top: 200, width: 400, height: 100 })

    const anchor = createAnchor(card, { point: { x: 200, y: 250 } })
    expect(anchor).toEqual({ kind: "element", selector: "#card", x: 250, y: 500 })
    expect(resolved(resolveAnchor(anchor))).toMatchObject({ x: 200, y: 250, kind: "element" })
  })

  it("follows the element after a layout change", () => {
    page(`<div id="card"></div>`)
    const card = document.getElementById("card")!
    place(card, { left: 0, top: 0, width: 200, height: 200 })
    const anchor = createAnchor(card, { point: { x: 50, y: 150 } })

    place(card, { left: 40, top: 300, width: 800, height: 400 })
    expect(resolved(resolveAnchor(anchor))).toMatchObject({ x: 40 + 200, y: 300 + 300 })
  })

  it("finds an element that moved in the DOM when it has an id", () => {
    page(`<section><div id="card"></div></section><aside></aside>`)
    const card = document.getElementById("card")!
    place(card, { left: 0, top: 0, width: 100, height: 100 })
    const anchor = createAnchor(card)

    document.querySelector("aside")!.append(card)
    expect(resolved(resolveAnchor(anchor)).element).toBe(card)
  })

  it("creates an anchor from a point over an element and skips ignored elements", () => {
    page(`<div id="card"></div><div id="layer"></div>`)
    const card = document.getElementById("card")!
    const layer = document.getElementById("layer")!
    place(card, { left: 0, top: 0, width: 100, height: 100 })
    document.elementsFromPoint = () => [layer, card, document.body]

    const anchor = createAnchor({ x: 10, y: 20 }, { ignore: element => element.id === "layer" })
    expect(anchor).toEqual({ kind: "element", selector: "#card", x: 100, y: 200 })
  })

  it("reports a detached anchor when the element is gone or hidden", () => {
    page(`<div id="card"></div>`)
    const card = document.getElementById("card")!
    place(card, { left: 0, top: 0, width: 100, height: 100 })
    const anchor = createAnchor(card)

    place(card, { left: 0, top: 0, width: 0, height: 0 })
    expect(resolveAnchor(anchor)).toEqual({ detached: true })
    card.remove()
    expect(resolveAnchor(anchor)).toEqual({ detached: true })
  })

  it("returns detached for a selector that is not valid", () => {
    expect(resolveAnchor({ kind: "element", selector: "div[", x: 0, y: 0 })).toEqual({ detached: true })
  })

  it("keeps an area inside its element and resolves its size", () => {
    page(`<div id="hero"></div>`)
    const hero = document.getElementById("hero")!
    place(hero, { left: 0, top: 0, width: 1000, height: 500 })

    const anchor = createAnchor(hero, { area: { left: 100, top: 50, width: 2000, height: 100 } })
    expect(anchor).toEqual({ kind: "area", selector: "#hero", x: 100, y: 100, width: 900, height: 200 })

    place(hero, { left: 10, top: 10, width: 2000, height: 1000 })
    expect(resolved(resolveAnchor(anchor))).toMatchObject({ x: 210, y: 110, width: 1800, height: 200 })
  })

  it("makes an image anchor for a point or an area on an img", () => {
    page(`<img id="photo" alt="">`)
    const photo = document.getElementById("photo")!
    place(photo, { left: 0, top: 0, width: 200, height: 100 })

    expect(createAnchor(photo, { point: { x: 100, y: 50 } })).toEqual({ kind: "image", selector: "#photo", x: 500, y: 500 })
    expect(createAnchor(photo, { area: { left: 0, top: 0, width: 100, height: 50 } })).toEqual({
      kind: "image",
      selector: "#photo",
      x: 0,
      y: 0,
      width: 500,
      height: 500,
    })
  })

  it("makes a page anchor", () => {
    expect(createAnchor("page")).toEqual({ kind: "page" })
    expect(resolveAnchor({ kind: "page" })).toMatchObject({ detached: false, kind: "page" })
  })

  it("throws a coded error when nothing can be anchored", () => {
    document.elementsFromPoint = () => []
    expect(() => createAnchor({ x: 1, y: 1 })).toThrowError(expect.objectContaining({ code: "COMMENTS_R0001" }))
    const range = document.createRange()
    expect(() => createAnchor(range)).toThrowError(expect.objectContaining({ code: "COMMENTS_R0001" }))
  })
})

describe("text anchors", () => {
  function select(node: Node, start: number, end: number): Range {
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
  }

  it("quotes a selection with its prefix and suffix and finds it again", () => {
    page(`<p id="copy">Ship it today. Ship it tomorrow. Ship it never.</p>`)
    const copy = document.getElementById("copy")!
    place(copy, { left: 10, top: 20, width: 300, height: 40 })
    const text = copy.firstChild!

    const anchor = createAnchor(select(text, 33, 40), { context: 8 })
    expect(anchor).toEqual({ kind: "text", selector: "#copy", exact: "Ship it", prefix: "morrow. ", suffix: " never." })

    const position = resolved(resolveAnchor(anchor))
    expect(position).toMatchObject({ kind: "text", element: copy, x: 10, y: 20 })
  })

  it("picks the quote whose surroundings match when the text repeats", () => {
    page(`<p id="copy">Go. Stop. Go. Stop.</p>`)
    const copy = document.getElementById("copy")!
    place(copy, { left: 0, top: 0, width: 100, height: 20 })
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      const start = this.startOffset
      const box = { left: start * 10, top: 0, width: 20, height: 20 }
      return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box }
    })
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [] as unknown as DOMRectList)

    const anchor = createAnchor(select(copy.firstChild!, 10, 13), { context: 6 })
    expect(anchor).toMatchObject({ exact: "Go.", prefix: "Stop. ", suffix: " Stop." })
    expect(resolved(resolveAnchor(anchor)).x).toBe(100)
  })

  it("quotes text across elements using the nearest common element", () => {
    page(`<p id="copy">Hello <b>big</b> world</p>`)
    const copy = document.getElementById("copy")!
    place(copy, { left: 0, top: 0, width: 100, height: 20 })
    const range = document.createRange()
    range.setStart(copy.firstChild!, 3)
    range.setEnd(copy.lastChild!, 3)

    const anchor = createAnchor(range, { context: 4 })
    expect(anchor).toMatchObject({ kind: "text", selector: "#copy", exact: "lo big wo", prefix: "Hel", suffix: "rld" })
    expect(resolveAnchor(anchor).detached).toBe(false)
  })

  it("accepts a Selection", () => {
    page(`<p id="copy">Pick this</p>`)
    const copy = document.getElementById("copy")!
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(select(copy.firstChild!, 5, 9))

    expect(createAnchor(selection)).toMatchObject({ kind: "text", exact: "this", prefix: "Pick " })
  })

  it("detaches when the text changed", () => {
    page(`<p id="copy">Old words</p>`)
    const copy = document.getElementById("copy")!
    place(copy, { left: 0, top: 0, width: 100, height: 20 })
    const anchor = createAnchor(select(copy.firstChild!, 0, 3))

    copy.textContent = "New words"
    expect(resolveAnchor(anchor)).toEqual({ detached: true })
  })
})

describe("ambiguous and clipped anchors", () => {
  it("detaches an element anchor whose selector names more than one element", () => {
    page(`<p class="a">One</p><p class="b">Two</p>`)
    for (const element of document.querySelectorAll("p")) place(element, { left: 0, top: 0, width: 10, height: 10 })
    expect(resolveAnchor({ kind: "element", selector: "p", x: 0, y: 0 })).toEqual({ detached: true })
    expect(resolveAnchor({ kind: "area", selector: "p", x: 0, y: 0, width: 100, height: 100 })).toEqual({ detached: true })
    expect(resolveAnchor({ kind: "image", selector: "p", x: 0, y: 0 })).toEqual({ detached: true })
  })

  it("tries every element of a text selector and takes the one that holds the quote", () => {
    page(`<p>Nothing here</p><p>Look: the quick fox</p>`)
    for (const element of document.querySelectorAll("p")) place(element, { left: 5, top: 5, width: 100, height: 10 })
    const position = resolveAnchor({ kind: "text", selector: "p", exact: "quick fox", prefix: "the ", suffix: "" })
    expect(resolved(position).element).toBe(document.querySelectorAll("p")[1])
  })

  it("marks a spot that a scroll container clips", () => {
    page(`<div id="list" style="overflow: auto"><div id="row"></div></div>`)
    const list = document.getElementById("list")!
    const row = document.getElementById("row")!
    place(list, { left: 0, top: 0, width: 200, height: 100 })
    place(row, { left: 0, top: 0, width: 200, height: 40 })
    const anchor = createAnchor(row)
    expect(resolved(resolveAnchor(anchor)).clipped).toBe(false)

    // The list scrolled, so the row is above its top edge.
    place(row, { left: 0, top: -300, width: 200, height: 40 })
    expect(resolved(resolveAnchor(anchor)).clipped).toBe(true)
  })

  it("does not mark a spot as clipped when no ancestor clips", () => {
    page(`<div id="box"><div id="row"></div></div>`)
    place(document.getElementById("box")!, { left: 0, top: 0, width: 10, height: 10 })
    place(document.getElementById("row")!, { left: 0, top: 500, width: 200, height: 40 })
    expect(resolved(resolveAnchor({ kind: "element", selector: "#row", x: 0, y: 0 })).clipped).toBe(false)
  })
})

describe("quote matching", () => {
  function quote(text: string, anchor: { exact: string, prefix: string, suffix: string }) {
    page(`<p id="copy">${text}</p>`)
    place(document.getElementById("copy")!, { left: 0, top: 0, width: 100, height: 20 })
    return resolveAnchor({ kind: "text", selector: "#copy", ...anchor })
  }

  it("finds a quote that occurs once, even when the text around it changed", () => {
    expect(quote("A whole new sentence with fox in it.", { exact: "fox", prefix: "the quick ", suffix: " jumps" }).detached).toBe(false)
  })

  it("detaches a short word that now occurs only elsewhere and more than once", () => {
    // The comment was on "it" in "Ship it today". That sentence is gone, and "it" is inside other words.
    const position = quote("Admit it. Permit it. Submit it.", { exact: "it", prefix: "Ship ", suffix: " today" })
    expect(position).toEqual({ detached: true })
  })

  it("accepts a repeated quote when enough of its context still matches", () => {
    const position = quote("Go now. Stop now. Go later.", { exact: "Go", prefix: "now. Stop now. ", suffix: " later." })
    expect(resolved(position).x).toBe(0)
    expect(position.detached).toBe(false)
  })

  it("detaches a repeated quote that has no context to tell the copies apart", () => {
    expect(quote("Go. Go. Go.", { exact: "Go", prefix: "", suffix: "" })).toEqual({ detached: true })
  })
})
