<script setup lang="ts">
import { EditorContent } from "@tiptap/vue-3";
import { useComarkEditor } from "comark-tiptap/vue";
import { onBeforeUnmount, ref, watch } from "vue";

import type { EditorToolbarItem } from "@nuxt/ui";

/**
 * Markdown body editor. Rich mode edits through Tiptap with the Comark kit, so Comark syntax round-trips; Source mode
 * edits the Markdown text directly. Both modes write the same Markdown string to `v-model`.
 */
const props = defineProps<{
  disabled?: boolean;
  label?: string;
}>();

const model = defineModel<string>({ required: true });
const mode = ref<"rich" | "source">("rich");
const renderError = ref<string>();
// The last Markdown this component wrote, so an incoming value that matches it is not applied back to the editor.
let written = model.value;
let pending: ReturnType<typeof setTimeout> | undefined;

// The Markdown seed is applied after mount without an update, so opening a document does not mark it as changed.
const { editor, getMarkdown, setContent } = useComarkEditor({
  contentType: "markdown",
  editorOptions: {
    editable: !props.disabled,
    editorProps: { attributes: { "aria-label": props.label ?? "Body", class: "vitehub-markdown-editor__content" } },
  },
  onError: (error) => {
    renderError.value = error instanceof Error ? error.message : "The editor could not render this Markdown.";
  },
  // Only user edits emit updates. Values applied from the model use `emitUpdate: false`.
  onUpdate: () => schedule(),
});

async function flush(): Promise<void> {
  pending = undefined;
  const markdown = await getMarkdown();
  if (markdown === null) return;
  written = markdown;
  model.value = markdown;
}

function schedule(): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => void flush(), 120);
}

/** Writes pending rich-text edits to the model now, for example before a save. */
async function commit(): Promise<void> {
  if (!pending) return;
  clearTimeout(pending);
  await flush();
}

watch(editor, (instance) => {
  if (instance) void setContent(model.value, { emitUpdate: false });
}, { once: true });

watch(model, (value) => {
  if (value === written) return;
  written = value;
  // Source mode already shows the model. Rich mode reparses it.
  if (mode.value === "rich") void setContent(value, { emitUpdate: false });
});

watch(mode, (value) => {
  if (value === "rich") void setContent(model.value, { emitUpdate: false });
});

watch(() => props.disabled, (disabled) => {
  editor.value?.setEditable(!disabled, false);
});

onBeforeUnmount(() => {
  if (pending) clearTimeout(pending);
});

defineExpose({ commit });

const toolbar = [
  [
    {
      icon: "i-lucide-heading",
      items: [
        { kind: "paragraph", label: "Paragraph", icon: "i-lucide-pilcrow" },
        { kind: "heading", level: 1, label: "Heading 1", icon: "i-lucide-heading-1" },
        { kind: "heading", level: 2, label: "Heading 2", icon: "i-lucide-heading-2" },
        { kind: "heading", level: 3, label: "Heading 3", icon: "i-lucide-heading-3" },
      ],
      tooltip: { text: "Text style" },
    },
  ],
  [
    { kind: "mark", mark: "bold", icon: "i-lucide-bold", "aria-label": "Bold", tooltip: { text: "Bold", kbds: ["meta", "b"] } },
    { kind: "mark", mark: "italic", icon: "i-lucide-italic", "aria-label": "Italic", tooltip: { text: "Italic", kbds: ["meta", "i"] } },
    { kind: "mark", mark: "strike", icon: "i-lucide-strikethrough", "aria-label": "Strikethrough", tooltip: { text: "Strikethrough" } },
    { kind: "mark", mark: "code", icon: "i-lucide-code", "aria-label": "Inline code", tooltip: { text: "Inline code" } },
    { kind: "link", icon: "i-lucide-link", "aria-label": "Link", tooltip: { text: "Link" } },
  ],
  [
    { kind: "bulletList", icon: "i-lucide-list", "aria-label": "Bullet list", tooltip: { text: "Bullet list" } },
    { kind: "orderedList", icon: "i-lucide-list-ordered", "aria-label": "Numbered list", tooltip: { text: "Numbered list" } },
    { kind: "blockquote", icon: "i-lucide-text-quote", "aria-label": "Quote", tooltip: { text: "Quote" } },
    { kind: "codeBlock", icon: "i-lucide-square-code", "aria-label": "Code block", tooltip: { text: "Code block" } },
  ],
  [
    { kind: "undo", icon: "i-lucide-undo-2", "aria-label": "Undo", tooltip: { text: "Undo", kbds: ["meta", "z"] } },
    { kind: "redo", icon: "i-lucide-redo-2", "aria-label": "Redo", tooltip: { text: "Redo", kbds: ["meta", "shift", "z"] } },
  ],
] satisfies EditorToolbarItem[][];
</script>

<template>
  <section class="vitehub-markdown-editor overflow-hidden rounded-md border border-default bg-default" :aria-label="label ?? 'Body'">
    <div class="flex min-h-10 items-center gap-2 border-b border-default px-1.5">
      <UEditorToolbar v-if="editor && mode === 'rich'" :editor="editor" :items="toolbar" active-color="neutral" class="min-w-0 flex-1 overflow-x-auto" :ui="{ base: 'gap-0.5' }" />
      <span v-else class="min-w-0 flex-1 px-1.5 text-xs text-muted">Markdown source</span>
      <UTabs
        v-model="mode"
        :content="false"
        size="xs"
        variant="pill"
        color="neutral"
        :items="[{ label: 'Rich', value: 'rich' }, { label: 'Source', value: 'source' }]"
        :ui="{ list: 'p-0.5', trigger: 'px-2' }"
        aria-label="Body editing mode"
      />
    </div>
    <div v-show="mode === 'rich'">
      <EditorContent v-if="editor" :editor="editor" />
      <div v-else class="px-5 py-4 text-sm text-muted">Loading editor…</div>
      <p v-if="renderError" class="border-t border-default px-4 py-2 text-xs text-warning">{{ renderError }} Switch to Source to edit the Markdown directly.</p>
    </div>
    <UTextarea
      v-if="mode === 'source'"
      v-model="model"
      :disabled="disabled"
      autoresize
      :rows="16"
      variant="none"
      class="w-full"
      :ui="{ base: 'min-h-80 px-5 py-4 font-mono text-[13px] leading-6' }"
      aria-label="Markdown source"
    />
  </section>
</template>

<style>
.vitehub-markdown-editor__content {
  color: var(--ui-text);
  font-size: 0.9375rem;
  line-height: 1.7;
  min-height: 20rem;
  outline: none;
  padding: 1rem 1.25rem 2rem;
}

.vitehub-markdown-editor__content > * + * {
  margin-top: 0.75em;
}

.vitehub-markdown-editor__content h1,
.vitehub-markdown-editor__content h2,
.vitehub-markdown-editor__content h3 {
  color: var(--ui-text-highlighted);
  font-weight: 600;
  line-height: 1.3;
}

.vitehub-markdown-editor__content h1 { font-size: 1.5rem; margin-top: 1.25em; }
.vitehub-markdown-editor__content h2 { font-size: 1.25rem; margin-top: 1.25em; }
.vitehub-markdown-editor__content h3 { font-size: 1.0625rem; margin-top: 1em; }
.vitehub-markdown-editor__content > :first-child { margin-top: 0; }

.vitehub-markdown-editor__content ul { list-style: disc; padding-inline-start: 1.5rem; }
.vitehub-markdown-editor__content ol { list-style: decimal; padding-inline-start: 1.5rem; }

.vitehub-markdown-editor__content blockquote {
  border-inline-start: 2px solid var(--ui-border-accented);
  color: var(--ui-text-muted);
  padding-inline-start: 1rem;
}

.vitehub-markdown-editor__content a {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.vitehub-markdown-editor__content code {
  background: var(--ui-bg-elevated);
  border-radius: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.85em;
  padding: 0.1em 0.3em;
}

.vitehub-markdown-editor__content pre {
  background: var(--ui-bg-muted);
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  overflow-x: auto;
  padding: 0.75rem 1rem;
}

.vitehub-markdown-editor__content pre code {
  background: none;
  padding: 0;
}

.vitehub-markdown-editor__content hr {
  border-color: var(--ui-border);
}

.vitehub-markdown-editor__content table {
  border-collapse: collapse;
  width: 100%;
}

.vitehub-markdown-editor__content th,
.vitehub-markdown-editor__content td {
  border: 1px solid var(--ui-border);
  padding: 0.375rem 0.625rem;
  text-align: start;
}

.vitehub-markdown-editor__content img {
  border-radius: 0.375rem;
  max-width: 100%;
}
</style>
