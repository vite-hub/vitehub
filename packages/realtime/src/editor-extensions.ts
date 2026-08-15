import Image from "@tiptap/extension-image"
import Document from "@tiptap/extension-document"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { Marked } from "marked"

import { Frontmatter } from "./frontmatter.ts"

const RealtimeDocument = Document.extend({ content: "frontmatter? block*" })

export function createRealtimeEditorExtensions() {
  return [
    StarterKit.configure({ document: false, undoRedo: false }),
    RealtimeDocument,
    Image,
    TableKit,
    Frontmatter,
    Markdown.configure({ marked: new Marked() as unknown as typeof import("marked").marked }),
  ]
}
