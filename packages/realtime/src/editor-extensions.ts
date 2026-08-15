import Image from "@tiptap/extension-image"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import StarterKit from "@tiptap/starter-kit"
import { Marked } from "marked"

import { Frontmatter } from "./frontmatter.ts"

export function createRealtimeEditorExtensions() {
  return [
    StarterKit.configure({ undoRedo: false }),
    Image,
    TableKit,
    Frontmatter,
    Markdown.configure({ marked: new Marked() as unknown as typeof import("marked").marked }),
  ]
}
