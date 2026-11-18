// @vitest-environment happy-dom
import { EditorContent } from "@tiptap/vue-3"
import { createContentEditorCodec } from "@vite-hub/content/editor"
import { flushPromises, shallowMount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type DefineComponent, defineComponent, h } from "vue"

import ConsoleMarkdownEditor from "../src/console/runtime/components/console-markdown-editor.vue"

vi.mock("../src/console/runtime/components/console-comark-component.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-media-dialog.vue", () => ({ default: { render: () => null } }))
vi.mock("@vite-hub/content/editor", async importOriginal => {
  const actual = await importOriginal<typeof import("@vite-hub/content/editor")>()
  return { ...actual, createContentEditorCodec: vi.fn(actual.createContentEditorCodec) }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function mountEditor() {
  type EditorComponent = DefineComponent<{ active?: boolean, collection: string, modelValue: string }>
  const wrapper = shallowMount<typeof ConsoleMarkdownEditor, EditorComponent>(ConsoleMarkdownEditor, {
    props: { active: true, collection: "posts", modelValue: "Original\n" },
    global: {
      stubs: {
        UButton: true, UDropdownMenu: true, UEditorDragHandle: true, UEditorSuggestionMenu: true,
        UEditorToolbar: true, UIcon: true, UInput: true, UPopover: true,
      },
    },
  })
  await flushPromises()
  const editor = wrapper.getComponent(EditorContent).props("editor")
  if (!editor) throw new Error("Rich editor did not initialize")
  await vi.waitFor(() => expect(editor.isEditable).toBe(true))
  const codec = vi.mocked(createContentEditorCodec).mock.results.at(-1)!.value
  vi.useFakeTimers()
  return {
    wrapper,
    editor,
    codec,
    serialize: () => codec.toMarkdown(editor.getJSON()),
    // Vue exposes commit to the document editor through the same component ref.
    commit: async (): Promise<void> => { await wrapper.vm.$.exposed!.commit() },
  }
}

describe("Rich edit commits", () => {
  it("awaits serialization that the debounce already started before a Source switch", async () => {
    const { wrapper, editor, codec, serialize, commit } = await mountEditor()
    const blocked = deferred<string>()
    try {
      editor.commands.insertContentAt(1, { type: "text", text: "Edited " })
      const markdown = await serialize()
      const serializing = vi.spyOn(codec, "toMarkdown").mockReturnValueOnce(blocked.promise)
      await vi.advanceTimersByTimeAsync(120)
      expect(serializing).toHaveBeenCalledOnce()

      let switched = false
      const switching = commit().then(async () => {
        switched = true
        await wrapper.setProps({ active: false })
      })
      await flushPromises()
      expect(switched).toBe(false)
      blocked.resolve(markdown)
      await switching
      expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([markdown])
    }
    finally {
      blocked.resolve("Original\n")
      await flushPromises()
      wrapper.unmount()
    }
  })

  it("makes Rich read-only while a pending edit commits and restores editability afterward", async () => {
    const { wrapper, editor, codec, serialize, commit } = await mountEditor()
    const blocked = deferred<string>()
    try {
      editor.commands.insertContentAt(1, { type: "text", text: "Edited " })
      const markdown = await serialize()
      vi.spyOn(codec, "toMarkdown").mockReturnValueOnce(blocked.promise)
      const committing = commit()
      expect(editor.isEditable).toBe(false)
      blocked.resolve(markdown)
      await committing
      expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([markdown])
      expect(editor.isEditable).toBe(true)
    }
    finally {
      blocked.resolve("Original\n")
      await flushPromises()
      wrapper.unmount()
    }
  })

  it("drains an edit queued while an earlier snapshot was being serialized", async () => {
    const { wrapper, editor, codec, serialize, commit } = await mountEditor()
    const blocked = deferred<string>()
    try {
      editor.commands.insertContentAt(1, { type: "text", text: "First " })
      const first = await serialize()
      vi.spyOn(codec, "toMarkdown").mockReturnValueOnce(blocked.promise)
      await vi.advanceTimersByTimeAsync(120)

      editor.commands.insertContentAt(1, { type: "text", text: "Second " })
      const latest = await serialize()
      const committing = commit()
      blocked.resolve(first)
      await committing
      expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([latest])
    }
    finally {
      blocked.resolve("Original\n")
      await flushPromises()
      wrapper.unmount()
    }
  })

  it("discards an in-flight snapshot after another view replaces the model", async () => {
    const { wrapper, editor, codec, serialize } = await mountEditor()
    const blocked = deferred<string>()
    try {
      editor.commands.insertContentAt(1, { type: "text", text: "Edited " })
      const markdown = await serialize()
      vi.spyOn(codec, "toMarkdown").mockReturnValueOnce(blocked.promise)
      await vi.advanceTimersByTimeAsync(120)
      await wrapper.setProps({ active: false, modelValue: "Source replacement\n" })
      blocked.resolve(markdown)
      await flushPromises()
      expect(wrapper.emitted("update:modelValue")).toBeUndefined()

      await wrapper.setProps({ active: true })
      await vi.waitFor(() => expect(editor.isEditable).toBe(true))
      expect((await serialize()).trimEnd()).toBe("Source replacement")
    }
    finally {
      blocked.resolve("Original\n")
      await flushPromises()
      wrapper.unmount()
    }
  })
})

describe("Block menu", () => {
  // Nuxt UI's handle and menu, reduced to what the editor uses: the handle's slot, and the menu's items and `update:open`.
  const selected = vi.fn()
  const DragHandle = defineComponent({
    setup(_, { slots }) {
      // Nuxt UI's `onClick` selects the block under the handle and returns it.
      const onClick = () => selected()
      return () => h("div", slots.default?.({ onClick, ui: { handle: () => "" } }))
    },
  })
  const DropdownMenu = defineComponent({
    props: { items: { default: () => [], type: Array } },
    emits: ["update:open"],
    setup(_, { slots }) {
      return () => h("div", slots.default?.({ open: false }))
    },
  })

  it("selects the block under the handle when Enter opens the menu, without a click", async () => {
    const wrapper = shallowMount(ConsoleMarkdownEditor, {
      props: { active: true, collection: "posts", modelValue: "Original\n" },
      global: {
        stubs: {
          UButton: true, UDropdownMenu: DropdownMenu, UEditorDragHandle: DragHandle, UEditorSuggestionMenu: true,
          UEditorToolbar: true, UIcon: true, UInput: true, UPopover: true,
        },
      },
    })
    try {
      await flushPromises()
      const editor = wrapper.getComponent(EditorContent).props("editor")
      await vi.waitFor(() => expect(editor?.isEditable).toBe(true))
      const menu = await vi.waitFor(() => wrapper.getComponent(DropdownMenu))
      // A keyboard opens Nuxt UI's menu on keydown, and no click follows.
      menu.vm.$emit("update:open", true)
      await flushPromises()
      expect(selected).toHaveBeenCalledOnce()
      menu.vm.$emit("update:open", false)
      expect(selected).toHaveBeenCalledOnce()
    }
    finally {
      wrapper.unmount()
    }
  })
})
