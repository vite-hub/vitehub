import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { parseHTML } from "linkedom"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { createRealtimeEditorExtensions } from "../src/editor.ts"

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
