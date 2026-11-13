import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { parseHTML } from "linkedom"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { createRealtimeEditorExtensions, realtimeMarkdownEditor } from "../src/editor.ts"

function stubDom() {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>")
  Object.defineProperty(document, "implementation", {
    value: { createHTMLDocument: () => parseHTML("<!doctype html><html><body></body></html>").document },
  })
  Object.defineProperty(document, "getSelection", {
    value: () => ({ addRange() {}, rangeCount: 0, removeAllRanges() {} }),
  })
  vi.stubGlobal("document", document)
  vi.stubGlobal("window", window)
}

describe("realtime editor extensions", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("adds no empty paragraph per collaborator after a document that ends in a list", () => {
    stubDom()
    const docs = [new Y.Doc(), new Y.Doc()]
    // Relay every update to the other document, as the room does.
    docs.forEach((doc, index) => doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "relay") Y.applyUpdate(docs[1 - index]!, update, "relay")
    }))
    const editors = docs.map(doc => new Editor({
      extensions: [...createRealtimeEditorExtensions({ collaborative: true }), Collaboration.configure({ fragment: doc.getXmlFragment("body") })],
      injectCSS: false,
    }))
    editors[0]!.commands.setContent({ type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] }] })

    for (const editor of editors) {
      expect(editor.getJSON().content?.map(node => node.type)).toEqual(["bulletList"])
      editor.destroy()
    }
  })
})

describe("realtime Markdown editor", () => {
  const readAndWrite = async (markdown: string) => realtimeMarkdownEditor.toMarkdown(await realtimeMarkdownEditor.fromMarkdown(markdown))

  it("writes a GitHub alert back as an alert", async () => {
    for (const markdown of [
      "> [!NOTE]\n> Useful to know.",
      "> [!warning]\n> Take care.\n>\n> A second paragraph.",
      "Before.\n\n> [!TIP]\n> A tip with a [link](https://example.com).\n\nAfter.",
    ]) {
      expect(await readAndWrite(markdown)).toBe(markdown)
    }
  })

  it("escapes brackets that are not an alert's first line", async () => {
    expect(await readAndWrite("> [!NOTE] on the same line")).toBe("> \\[!NOTE\\] on the same line")
    expect(await readAndWrite("> A quote.\n> [!NOTE]")).toBe("> A quote.\n> \\[!NOTE\\]")
    expect(await readAndWrite("> [!DRAFT]\n> Not an alert.")).toBe("> \\[!DRAFT\\]\n> Not an alert.")
    expect(await readAndWrite("[!NOTE]")).toBe("\\[!NOTE\\]")
  })
})
