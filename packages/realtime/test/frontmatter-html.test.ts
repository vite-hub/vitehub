import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMParser } from "@tiptap/pm/model"
import { parseHTML } from "linkedom"

import { createRealtimeEditorExtensions } from "../src/editor-extensions.ts"

describe("frontmatter HTML", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    { sentinel: true, value: null },
    { sentinel: false, value: "" },
  ])("round-trips delimiter-only value $value", ({ sentinel, value }) => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>")
    Object.defineProperty(document, "implementation", {
      value: { createHTMLDocument: () => parseHTML("<!doctype html><html><body></body></html>").document },
    })
    Object.defineProperty(document, "getSelection", {
      value: () => ({ addRange() {}, rangeCount: 0, removeAllRanges() {} }),
    })
    vi.stubGlobal("document", document)
    vi.stubGlobal("window", window)

    const source = new Editor({
      extensions: createRealtimeEditorExtensions(),
      content: { type: "doc", content: [{ type: "frontmatter", attrs: { value } }] },
      injectCSS: false,
    })

    const html = source.getHTML()
    const serialized = parseHTML(html).document.querySelector("pre")!
    expect(serialized.hasAttribute("data-frontmatter")).toBe(true)
    expect(serialized.hasAttribute("data-frontmatter-empty")).toBe(sentinel)
    expect(serialized.textContent).toBe("")

    const parsedDocument = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
    const parsed = DOMParser.fromSchema(source.schema).parse(parsedDocument.body)
    expect(parsed.toJSON()).toEqual({
      type: "doc",
      content: [{ type: "frontmatter", attrs: { value } }],
    })

    source.destroy()
  })
})
