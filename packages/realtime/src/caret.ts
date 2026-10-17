import { Extension } from "@tiptap/core"
import { defaultSelectionBuilder, yCursorPlugin } from "@tiptap/y-tiptap"

import type { DecorationAttrs } from "@tiptap/pm/view"
import type { Awareness } from "y-protocols/awareness"

/** A remote person as the caret sees them: the presence identity from awareness. */
export interface RealtimeCaretUser {
  color: string
  name: string
  [key: string]: unknown
}

export interface RealtimeCaretOptions {
  awareness: Awareness | null
  /** Builds a remote caret. Defaults to TipTap's `collaboration-carets__caret` and `collaboration-carets__label`. */
  render: (user: RealtimeCaretUser) => HTMLElement
  /** Decoration attributes for a remote selection. Defaults to `ProseMirror-yjs-selection` in the person's color. */
  selectionRender: (user: RealtimeCaretUser) => DecorationAttrs
}

const validColor = /^#[0-9a-f]{6}$/i

/**
 * Other people's carets and selections, drawn from the room's awareness. It renders what TipTap's CollaborationCaret
 * renders, under the same extension name, but it uses Realtime's bundled y-tiptap: CollaborationCaret installed next to
 * Realtime has its own copy, cannot find Realtime's sync plugin, and draws nothing. Presence identity stays Realtime's.
 */
export const RealtimeCaret = Extension.create<RealtimeCaretOptions>({
  name: "collaborationCaret",
  priority: 999,
  addOptions() {
    return {
      awareness: null,
      render: (user) => {
        const caret = document.createElement("span")
        caret.classList.add("collaboration-carets__caret")
        caret.style.borderColor = user.color
        const label = document.createElement("div")
        label.classList.add("collaboration-carets__label")
        label.style.backgroundColor = user.color
        label.append(document.createTextNode(user.name))
        caret.append(label)
        return caret
      },
      selectionRender: user => defaultSelectionBuilder(user),
    }
  },
  addProseMirrorPlugins() {
    const { awareness, render, selectionRender } = this.options
    if (!awareness) return []
    // Colors are `#RRGGBB`: y-tiptap appends an alpha to tint selections.
    const person = (user: { color?: unknown, name?: unknown }): RealtimeCaretUser => ({
      ...user,
      color: typeof user.color === "string" && validColor.test(user.color) ? user.color : "transparent",
      name: typeof user.name === "string" ? user.name : "",
    })
    return [yCursorPlugin(awareness, {
      cursorBuilder: user => render(person(user)),
      selectionBuilder: (user) => {
        const current = person(user)
        return current.color === "transparent" ? {} : selectionRender(current)
      },
    })]
  },
})
