// @vitest-environment happy-dom
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { Editor } from "@tiptap/core"

vi.mock("@nuxt/ui/utils/editor", () => ({ createHandlers: () => ({}), mapEditorItems: () => [] }))
vi.mock("../src/console/runtime/components/console-comark-component.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-media-dialog.vue", () => ({ default: {} }))

import MarkdownEditor from "../src/console/runtime/components/console-markdown-editor.vue"

describe("Console Markdown loads", () => {
  it.each([false, true])("keeps a load out of undo history (Source reload: %s)", async (reload) => {
    const wrapper = mount({ ...MarkdownEditor, render: () => null }, {
      props: { active: true, collection: "posts", modelValue: "Initial body." },
    })
    try {
      let editor: Editor | undefined
      await vi.waitFor(() => {
        editor = (wrapper.vm.$ as unknown as { setupState: { editor: Editor } }).setupState.editor
        expect(editor?.getText()).toBe("Initial body.")
      })
      if (!editor) throw new Error("The editor did not mount")
      if (reload) {
        await wrapper.setProps({ active: false })
        await wrapper.setProps({ modelValue: "Changed in Source." })
        await wrapper.setProps({ active: true })
        await vi.waitFor(() => expect(editor?.getText()).toBe("Changed in Source."))
      }
      const loaded = editor.getText()
      expect(editor.can().undo()).toBe(false)
      editor.commands.undo()
      expect(editor.getText()).toBe(loaded)
      editor.commands.insertContentAt(1, "Rich edit. ")
      expect(editor.commands.undo()).toBe(true)
      expect(editor.getText()).toBe(loaded)
    } finally {
      wrapper.unmount()
    }
  })
})
