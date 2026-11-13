import { Editor } from "@tiptap/core"
import Blockquote from "@tiptap/extension-blockquote"
import Code from "@tiptap/extension-code"
import Image from "@tiptap/extension-image"
import Document from "@tiptap/extension-document"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { Marked } from "marked"

import type { JSONContent } from "@tiptap/core"
import type { RealtimeEditor } from "./types.ts"
import { Frontmatter } from "./frontmatter.ts"

const RealtimeDocument = Document.extend({
  content: "frontmatter? block+",
  renderMarkdown(node, helpers, context) {
    const [frontmatter, paragraph] = node.content ?? []
    // The schema keeps an editable paragraph after frontmatter, even when the file has no body.
    const content = node.content?.length === 2 && frontmatter?.type === "frontmatter"
      && paragraph?.type === "paragraph" && !paragraph.content?.length
      ? [frontmatter]
      : node.content
    return this.parent?.({ ...node, content }, helpers, context) ?? ""
  },
})
// Markdown permits links and emphasis around inline code, and its parser preserves those marks.
const RealtimeCode = Code.extend({ excludes: "" })

// @tiptap/markdown escapes every bracket in text, so it writes `> [!NOTE]` as `> \[!NOTE\]`, which is a plain quote.
const escapedAlertMarker = /^> \\\[!(note|tip|important|warning|caution)\\\](?=\n|$)/i

/** A blockquote that writes a GitHub alert's first line (`> [!NOTE]`) as it read it, so the alert stays an alert. */
const RealtimeBlockquote = Blockquote.extend({
  renderMarkdown(node, helpers, context) {
    return (this.parent?.(node, helpers, context) ?? "").replace(escapedAlertMarker, "> [!$1]")
  },
})

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
    StarterKit.configure({ blockquote: false, code: false, document: false, trailingNode: options.collaborative === true ? false : undefined, undoRedo: false }),
    RealtimeBlockquote,
    RealtimeCode,
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
      const document = editor.getJSON()
      if (document.content?.length === 1 && document.content[0]?.type === "frontmatter") {
        document.content.push({ type: "paragraph", attrs: {} })
      }
      return document
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
