import { Editor } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import Document from "@tiptap/extension-document"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { Marked } from "marked"

import type { JSONContent } from "@tiptap/core"
import type { RealtimeEditor } from "./types.ts"
import { Frontmatter } from "./frontmatter.ts"

const RealtimeDocument = Document.extend({ content: "frontmatter? block+" })

const emptyRealtimeEditorDocument: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

function createMarked(): typeof import("marked").marked {
  const instance: unknown = new Marked()
  // SAFETY: A Marked instance implements the parser surface @tiptap/markdown calls (lexer, parser, use); a
  // private instance keeps the frontmatter tokenizer off the shared `marked` defaults.
  return instance as typeof import("marked").marked
}

export function createRealtimeEditorExtensions(options: { collaborative?: boolean } = {}) {
  return [
    // Each collaborator's trailing node appends its own empty paragraph to the shared document, and the room keeps them all.
    StarterKit.configure({ document: false, trailingNode: options.collaborative === true ? false : undefined, undoRedo: false }),
    RealtimeDocument,
    Image,
    TableKit,
    Frontmatter,
    Markdown.configure({ marked: createMarked() }),
  ]
}

/** Declares an editor schema and Markdown codec that the server and the browser share. */
export function defineRealtimeEditor(editor: RealtimeEditor): RealtimeEditor {
  return editor
}

/**
 * The built-in Markdown kit: StarterKit, images, tables, and raw YAML frontmatter as an
 * atom node, parsed and printed by `@tiptap/markdown`. It runs headless on the server.
 */
export const realtimeMarkdownEditor: RealtimeEditor = defineRealtimeEditor({
  extensions: createRealtimeEditorExtensions,
  fromMarkdown(markdown) {
    const editor = new Editor({
      content: markdown || emptyRealtimeEditorDocument,
      contentType: "markdown",
      extensions: createRealtimeEditorExtensions(),
      injectCSS: false,
    })
    try {
      return editor.getJSON()
    }
    finally {
      editor.destroy()
    }
  },
  toMarkdown(document) {
    const editor = new Editor({ content: document, extensions: createRealtimeEditorExtensions(), injectCSS: false })
    try {
      return editor.getMarkdown()
    }
    finally {
      editor.destroy()
    }
  },
})
