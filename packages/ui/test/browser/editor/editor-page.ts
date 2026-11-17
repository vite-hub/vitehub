// The editor parts on one page: a `MarkdownEditor` (bubble toolbar, "/" menu, drag handle) and an editor whose drag
// handle opens a block menu, as the Console's does. `nuxt-ui/` mounts it with Nuxt UI's parts, `ui-sdk/` with
// `uiSdkComponents`; `editor.browser.mjs` drives both the same way. Each editor shows its Markdown in an `<output>`.
import { EditorContent } from "@tiptap/vue-3";
import { useComarkEditor } from "comark-ui/editor/vue";
import { computed, defineComponent, h, provide, ref, shallowRef, type Component } from "vue";

import { MarkdownEditor } from "../../../src/components/markdown-editor.ts";
import { createEditorHandlers, editorHandlersKey, mapEditorItems } from "../../../src/editor/handlers.ts";
import { useUIComponent } from "../../../src/internal/nuxt-ui.ts";

const BlockMenuEditor = defineComponent({
  setup() {
    const UButton = useUIComponent("UButton");
    const UDropdownMenu = useUIComponent("UDropdownMenu");
    const UEditorDragHandle = useUIComponent("UEditorDragHandle");
    const markdown = ref("# One\n\nTwo\n\nThree\n");
    const { editor } = useComarkEditor(markdown);
    const handlers = computed(createEditorHandlers);
    provide(editorHandlersKey, handlers);
    const block = shallowRef<{ pos: number }>();
    return () => {
      const current = editor.value;
      if (!current) return null;
      const pos = block.value?.pos ?? -1;
      const items = block.value
        ? mapEditorItems(current, [
            [{ icon: "i-lucide-copy", kind: "duplicate", label: "Duplicate", pos }],
            [{ icon: "i-lucide-arrow-up", kind: "moveUp", label: "Move up", pos }, { icon: "i-lucide-arrow-down", kind: "moveDown", label: "Move down", pos }],
            [{ icon: "i-lucide-trash-2", kind: "delete", label: "Delete", pos }],
          ])
        : [];
      return h("div", { class: "fixture" }, [
        h(EditorContent, { class: "vh-markdown-editor-content", editor: current }),
        h(UEditorDragHandle, { editor: current, onNodeChange: (node: { pos: number }) => (block.value = node) }, {
          // While the menu is open, the handle stays on its block, as the Console's does.
          default: ({ onClick, ui }: { onClick: () => void, ui: { handle: () => string } }) => h(UDropdownMenu, {
            items,
            "onUpdate:open": (open: boolean) => current.chain().setMeta("lockDragHandle", open).run(),
          }, () => h(UButton, {
            "aria-label": "Block actions",
            class: ui.handle(),
            color: "neutral",
            icon: "i-lucide-grip-vertical",
            size: "xs",
            variant: "ghost",
            onClick,
          })),
        }),
        h("output", { "data-output": "block-menu" }, markdown.value),
      ]);
    };
  },
});

export const EditorPage: Component = defineComponent({
  setup() {
    const markdown = ref("Hello world\n\nSecond line\n\nThird line\n");
    return () => h("main", [
      h("section", { "aria-label": "MarkdownEditor", "data-fixture": "markdown-editor" }, [
        h(MarkdownEditor, { modelValue: markdown.value, "onUpdate:modelValue": (value: string) => (markdown.value = value) }),
        h("output", { "data-output": "markdown-editor" }, markdown.value),
      ]),
      h("section", { "aria-label": "Block menu", "data-fixture": "block-menu" }, h(BlockMenuEditor)),
    ]);
  },
});
