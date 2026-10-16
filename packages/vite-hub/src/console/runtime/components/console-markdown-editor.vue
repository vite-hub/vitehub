<script setup lang="ts">
import { mapEditorItems, createHandlers } from "@nuxt/ui/utils/editor";
import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, nodeViewProps } from "@tiptap/vue-3";
import { parseMarkdown } from "comark";
import { defineComarkVueComponent, useComarkEditor } from "comark-tiptap/vue";
import { computed, defineComponent, h, onBeforeUnmount, provide, ref, shallowRef, watch } from "vue";

import {
  consoleComponentDefaults,
  consoleConvertibleNodes,
  consoleEditorComponents,
  consoleHeadingSlug,
  consoleMarkdownLoss,
  consoleSlashGroups,
  consoleTurnIntoItems,
} from "../client/editor";
import { useConsoleMediaPicker } from "../client/media";
import { useConsoleToast } from "../client/toast";
import ConsoleComarkComponent from "./console-comark-component.vue";
import ConsoleMediaDialog from "./console-media-dialog.vue";

import type { DropdownMenuItem, EditorCustomHandlers, EditorToolbarItem } from "@nuxt/ui";
import type { Editor, JSONContent } from "@tiptap/vue-3";
import type { ConsoleMediaItem, ConsoleMediaPicker } from "../client/media";
import type { ConsoleDocumentComponent } from "../definitions";

/**
 * The document body: a block editor over Markdown. Comark is the document model, so Markdown and Comark components
 * round-trip; Nuxt UI provides the bubble toolbar, the block handle, and the `/` menu. Selecting text shows formatting,
 * hovering a block shows ⋮⋮ (move, turn into, duplicate, delete) and + (insert below), and `/` inserts blocks, images,
 * and the collection's components. The editor writes Markdown to `v-model` and never rewrites a body nobody changed.
 */
const props = defineProps<{
  /** False while another view, such as Source, edits the same Markdown. The editor reloads the model when it returns. */
  active?: boolean;
  collection: string;
  components?: readonly ConsoleDocumentComponent[];
  disabled?: boolean;
  documentId?: string;
  label?: string;
}>();

const emit = defineEmits<{
  /** Headings of the body, for an outline. `pos` scrolls to one with `scrollTo()`. */
  outline: [headings: Array<{ id: string, level: number, pos: number, text: string }>];
}>();

const model = defineModel<string>({ required: true });
const toast = useConsoleToast();
const lossy = ref<string>();
// Mirrors `editor.isEditable`, which is not reactive.
const editable = ref(!props.disabled);
// The last Markdown this component wrote or loaded, so an incoming value that matches it is not applied back.
let written = model.value;
// The Markdown as loaded and what the editor serializes it to. An unchanged document writes back the loaded text, so
// canonical formatting never shows up as an edit.
let loaded = model.value;
let canonical: string | undefined;
let loading = 0;
let pending: ReturnType<typeof setTimeout> | undefined;

const components = computed(() => consoleEditorComponents(props.components));
const definitions = new Map(components.value.map(component => [component.name, component]));
const comarkComponents = components.value.map(component => defineComarkVueComponent({
  kind: component.kind,
  name: component.name,
  // A wrapper per component, so the shared node view knows which definition it renders.
  nodeView: defineComponent({
    name: `ConsoleComark${component.name}`,
    props: nodeViewProps,
    setup: nodeProps => () => h(ConsoleComarkComponent, { ...nodeProps, definition: component }),
  }),
  props: Object.fromEntries(Object.entries(component.props).map(([name, prop]) => [name, prop.default === undefined ? { type: prop.type } : { default: prop.default, type: prop.type }])),
}));

// Media: a provided picker, such as a Blob media library, or the editor's own dialog.
const providedPicker = useConsoleMediaPicker();
const dialog = ref<InstanceType<typeof ConsoleMediaDialog>>();
const picker: ConsoleMediaPicker = providedPicker ?? { pick: request => dialog.value?.pick(request) ?? Promise.resolve([]) };

function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter(file => file.type.startsWith("image/"));
}

async function insertImages(files: File[], at?: number): Promise<void> {
  const instance = editor.value;
  if (!instance || !instance.isEditable) return;
  let items: ConsoleMediaItem[];
  try {
    items = await picker.pick({ collection: props.collection, documentId: props.documentId, files, kind: "image" });
  }
  catch {
    toast.error("Couldn't insert the image. Try again.");
    return;
  }
  if (!items.length || instance.isDestroyed) return;
  const images = items.map(item => ({ attrs: { alt: item.alt ?? null, src: item.src, title: item.title ?? null }, type: "image" }));
  const chain = instance.chain().focus();
  if (at === undefined) chain.insertContent(images).run();
  else chain.insertContentAt(at, images).run();
}

// Paste and drop of image files go through the media picker instead of embedding the files.
const mediaDrop = Extension.create({
  name: "vitehubMediaDrop",
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleDrop: (view, event, _slice, moved) => {
          const files = imageFiles(event.dataTransfer?.files);
          if (moved || !files.length) return false;
          event.preventDefault();
          void insertImages(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = imageFiles(event.clipboardData?.files);
          if (!files.length) return false;
          void insertImages(files);
          return true;
        },
      },
    })];
  },
});

const { editor, getMarkdown, setContent } = useComarkEditor({
  components: comarkComponents,
  contentType: "markdown",
  editorOptions: {
    editable: !props.disabled,
    editorProps: { attributes: { "aria-label": props.label ?? "Body", "aria-multiline": "true", class: "vitehub-markdown-editor__content", role: "textbox" } },
  },
  extensions: [
    Placeholder.configure({
      includeChildren: false,
      placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level}` : "Type / for commands"),
      showOnlyCurrent: true,
    }),
    mediaDrop,
  ],
  kitOptions: {
    resolveSrc: src => providedPicker?.resolveSrc?.(src),
    starterKit: {
      dropcursor: { class: "vitehub-drop-cursor", color: "var(--ui-primary)", width: 2 },
      link: { openOnClick: false },
    },
  },
  onError: (error, context) => {
    // A node the editor cannot represent is dropped from the editor, not from the stored Markdown. Editing it here
    // would delete it, so the body becomes read-only in Rich mode.
    if (!loading) return;
    lossy.value = error instanceof Error ? error.message : "The rich editor cannot show part of this Markdown.";
  },
  onUpdate: () => {
    if (!loading) schedule();
    scheduleOutline();
  },
});

async function flush(): Promise<void> {
  pending = undefined;
  const markdown = await getMarkdown();
  if (markdown === null) return;
  const next = markdown === canonical ? loaded : markdown;
  written = next;
  model.value = next;
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

/** Loads Markdown without an update or an undo step, then records how the editor serializes it. */
function load(markdown: string): Promise<void> {
  const instance = editor.value;
  if (!instance) return Promise.resolve();
  const token = ++loading;
  lossy.value = undefined;
  return new Promise((resolve) => {
    const done = async () => {
      instance.off("transaction", onTransaction);
      clearTimeout(timeout);
      loaded = markdown;
      written = markdown;
      canonical = (await getMarkdown()) ?? undefined;
      lossy.value ??= await markdownLoss(markdown, canonical);
      if (token === loading) loading = 0;
      setEditable();
      publishOutline();
      resolve();
    };
    const onTransaction = ({ transaction }: { transaction: { getMeta: (key: string) => unknown } }) => {
      if (transaction.getMeta("vitehubLoad") === token) void done();
    };
    // Parsing is asynchronous. An empty body produces no transaction when the editor is already empty.
    const timeout = setTimeout(() => void done(), 3_000);
    instance.on("transaction", onTransaction);
    void setContent(markdown, { emitUpdate: false, transactionMeta: { addToHistory: false, vitehubLoad: token } });
  });
}

/** Why rich editing would lose part of `markdown`, or undefined when what the editor writes parses the same. */
async function markdownLoss(markdown: string, written: string | undefined): Promise<string | undefined> {
  if (written === undefined || written === markdown) return undefined;
  try {
    const [stored, rewritten] = await Promise.all([parseMarkdown(markdown), parseMarkdown(written)]);
    const lost = consoleMarkdownLoss(stored.nodes, rewritten.nodes);
    if (!lost) return undefined;
    return lost.length ? `Not supported here: ${lost.map(tag => `::${tag}`).join(", ")}.` : "Part of it would change shape.";
  }
  catch {
    return undefined;
  }
}

watch(editor, (instance) => {
  if (instance) void load(model.value);
}, { once: true });

watch(model, (value) => {
  if (value === written) return;
  written = value;
  if (props.active !== false) void load(value);
});

watch(() => props.active, (active) => {
  if (active === false) return;
  if (model.value !== loaded) void load(model.value);
});

function setEditable(): void {
  editable.value = !props.disabled && !lossy.value;
  editor.value?.setEditable(editable.value, false);
}

watch(() => props.disabled, setEditable);

// Outline: headings with their position, published after edits settle.
let outlineTimer: ReturnType<typeof setTimeout> | undefined;
function publishOutline(): void {
  const instance = editor.value;
  if (!instance) return;
  const headings: Array<{ id: string, level: number, pos: number, text: string }> = [];
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading" && node.textContent.trim()) headings.push({ id: consoleHeadingSlug(node.textContent), level: Number(node.attrs.level) || 1, pos, text: node.textContent });
    return node.type.name !== "heading" && node.type.name !== "paragraph";
  });
  emit("outline", headings);
}
function scheduleOutline(): void {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(publishOutline, 250);
}

/** Scrolls a block into view and puts the cursor at its start. */
function scrollTo(pos: number): void {
  const instance = editor.value;
  if (!instance) return;
  const dom = instance.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "instant", block: "start" });
  instance.chain().focus().setTextSelection(pos + 1).run();
}

/** Focuses the body, at its start by default, as Enter in the title does. */
function focus(position: "end" | "start" = "start"): void {
  editor.value?.chain().focus(position).run();
}

onBeforeUnmount(() => {
  if (pending) clearTimeout(pending);
  clearTimeout(outlineTimer);
});

defineExpose({ commit, focus, scrollTo });

// Editor handlers: Nuxt UI's, plus tables, images through the media picker, and collection components.
function replaceEmptyBlock(instance: Editor, content: JSONContent) {
  const { $from } = instance.state.selection;
  const empty = $from.depth > 0 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
  return empty
    ? instance.chain().focus().insertContentAt({ from: $from.before(), to: $from.after() }, content)
    : instance.chain().focus().insertContent(content);
}

const customHandlers = {
  component: {
    canExecute: () => true,
    execute: (instance: Editor, item?: { component?: string }) => {
      const component = item?.component ? definitions.get(item.component) : undefined;
      if (!component) return instance.chain();
      const attrs = consoleComponentDefaults(component);
      if (component.kind === "inline") return instance.chain().focus().insertContent({ attrs, content: [{ text: component.label, type: "text" }], type: component.name });
      return replaceEmptyBlock(instance, { attrs, content: [{ type: "paragraph" }], type: component.name });
    },
    isActive: () => false,
  },
  image: {
    canExecute: () => true,
    execute: (instance: Editor) => {
      void insertImages([]);
      return instance.chain();
    },
    isActive: (instance: Editor) => instance.isActive("image"),
  },
  table: {
    canExecute: (instance: Editor) => instance.can().insertTable({ cols: 3, rows: 3, withHeaderRow: true }),
    execute: (instance: Editor) => instance.chain().focus().insertTable({ cols: 3, rows: 3, withHeaderRow: true }),
    isActive: (instance: Editor) => instance.isActive("table"),
  },
} satisfies EditorCustomHandlers;
const handlers = computed(() => ({ ...createHandlers(), ...customHandlers }));
provide("editorHandlers", handlers);

const slashItems = computed(() => consoleSlashGroups(components.value));

// Bubble toolbar: Turn into first, then marks and link (Notion, Linear).
const turnInto = consoleTurnIntoItems.map(item => ({ ...item }));
const bubbleItems = computed(() => [
  [{
    activeColor: "neutral",
    activeVariant: "ghost",
    content: { align: "start" },
    items: [{ label: "Turn into", type: "label" }, ...turnInto],
    label: "Text",
    // Inside the bubble, so focus in the menu keeps the bubble open.
    portal: false,
    tooltip: { text: "Turn into" },
    trailingIcon: "i-lucide-chevron-down",
    // Opaque: a blurred menu inside the blurred bubble cannot blur the page behind both.
    ui: { content: "bg-default backdrop-blur-none", label: "text-xs" },
  }],
  [
    { "aria-label": "Bold", icon: "i-lucide-bold", kind: "mark", mark: "bold", tooltip: { kbds: ["meta", "b"], text: "Bold" } },
    { "aria-label": "Italic", icon: "i-lucide-italic", kind: "mark", mark: "italic", tooltip: { kbds: ["meta", "i"], text: "Italic" } },
    { "aria-label": "Strikethrough", icon: "i-lucide-strikethrough", kind: "mark", mark: "strike", tooltip: { kbds: ["meta", "shift", "s"], text: "Strikethrough" } },
    { "aria-label": "Inline code", icon: "i-lucide-code", kind: "mark", mark: "code", tooltip: { kbds: ["meta", "e"], text: "Inline code" } },
  ],
  [{ "aria-label": "Link", icon: "i-lucide-link", slot: "link" as const, tooltip: { text: "Link" } }],
] satisfies EditorToolbarItem[][]);

function showBubble({ editor: instance, state, view }: { editor: Editor, state: Editor["state"], view: Editor["view"] }): boolean {
  // Focus in the bubble's own menus, such as Turn into or the link field, keeps it open.
  const inBubble = document.activeElement instanceof Element && Boolean(document.activeElement.closest(".vitehub-bubble"));
  if ((!view.hasFocus() && !inBubble) || state.selection.empty || !instance.isEditable) return false;
  if (instance.isActive("image") || instance.isActive("codeBlock")) return false;
  // Node selections come from the block handle, which has its own menu.
  return !("node" in state.selection);
}

// Link popover in the bubble toolbar.
const linkOpen = ref(false);
const linkHref = ref("");
function openLink(open: boolean): void {
  linkOpen.value = open;
  if (open) linkHref.value = String(editor.value?.getAttributes("link").href ?? "");
}
function applyLink(): void {
  const instance = editor.value;
  if (!instance) return;
  const href = linkHref.value.trim();
  const chain = instance.chain().focus().extendMarkRange("link");
  if (href) chain.setLink({ href }).run();
  else chain.unsetLink().run();
  linkOpen.value = false;
}

// Block handle: the hovered block and its menu.
const handleNode = shallowRef<{ node: JSONContent | null, pos: number }>();
function blockItems(instance: Editor): DropdownMenuItem[][] {
  const selected = handleNode.value;
  const type = selected?.node?.type;
  if (!selected || !type) return [];
  const pos = selected.pos;
  // SAFETY: mapEditorItems keeps the shape of the dropdown items it gets and only adds active, disabled, and onSelect.
  return mapEditorItems(instance, [
    [
      ...(consoleConvertibleNodes.has(type) ? [{ children: turnInto, icon: "i-lucide-repeat-2", label: "Turn into" }] : []),
      { icon: "i-lucide-copy-plus", kind: "duplicate", label: "Duplicate", pos },
      { icon: "i-lucide-link", label: "Copy link", onSelect: () => void copyLink(instance, pos) },
    ],
    [
      { icon: "i-lucide-arrow-up", kind: "moveUp", label: "Move up", pos },
      { icon: "i-lucide-arrow-down", kind: "moveDown", label: "Move down", pos },
    ],
    [{ color: "error", icon: "i-lucide-trash-2", kind: "delete", label: "Delete", pos }],
  ], customHandlers) as DropdownMenuItem[][];
}

/** Copies a link to the section of this block: the document URL with the anchor of the heading at or above it. */
async function copyLink(instance: Editor, pos: number): Promise<void> {
  let anchor = "";
  instance.state.doc.forEach((node, offset) => {
    if (offset <= pos && node.type.name === "heading" && node.textContent.trim()) anchor = consoleHeadingSlug(node.textContent);
  });
  const url = new URL(window.location.href);
  url.hash = anchor;
  try {
    await navigator.clipboard.writeText(url.toString());
    toast.show({ title: anchor ? "Link to section copied" : "Link copied" });
  }
  catch {
    toast.error("Couldn't copy the link.");
  }
}

function insertBelow(instance: Editor | undefined, onClick: () => { pos: number } | undefined): void {
  if (!instance) return;
  const node = onClick();
  handlers.value.suggestion.execute(instance, { pos: node?.pos }).run();
}

function lockHandle(instance: Editor, open: boolean): void {
  instance.chain().setMeta("lockDragHandle", open).run();
}

// A link that names a section scrolls to it once the body loads.
watch(editor, (instance) => {
  if (!instance || !window.location.hash) return;
  const target = decodeURIComponent(window.location.hash.slice(1));
  setTimeout(() => {
    instance.state.doc.forEach((node, offset) => {
      if (node.type.name === "heading" && consoleHeadingSlug(node.textContent) === target) scrollTo(offset);
    });
  }, 300);
}, { once: true });
</script>

<template>
  <section class="vitehub-markdown-editor relative" :aria-label="label ?? 'Body'">
    <p v-if="lossy" class="mb-4 flex items-start gap-2 rounded-md bg-elevated/60 px-3 py-2 text-[13px] text-muted" role="status">
      <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <span>This body uses Markdown the rich editor can't keep, so it is read-only here. Edit it in Source (⌘/). <span class="text-xs text-dimmed">{{ lossy }}</span></span>
    </p>
    <template v-if="editor">
      <EditorContent :editor="editor" />
      <UEditorToolbar
        :editor="editor"
        layout="bubble"
        :items="bubbleItems"
        :should-show="showBubble"
        active-color="neutral"
        active-variant="soft"
        :ui="{ root: 'vitehub-bubble', base: 'gap-0.5' }"
        @keydown.escape="editor.commands.focus()"
      >
        <template #link>
          <UPopover :open="linkOpen" :portal="false" :content="{ align: 'start', side: 'bottom', sideOffset: 8 }" @update:open="openLink">
            <UButton
              icon="i-lucide-link"
              variant="ghost"
              size="sm"
              aria-label="Link"
              :active="editor.isActive('link')"
              active-variant="soft"
            />
            <template #content>
              <form class="flex w-72 items-center gap-1 p-1" @submit.prevent="applyLink">
                <UInput v-model="linkHref" autofocus class="flex-1" variant="none" placeholder="https://vitehub.dev" aria-label="Link URL" :ui="{ base: 'text-[13px]' }" />
                <UButton type="submit" size="xs" variant="ghost" icon="i-lucide-corner-down-left" aria-label="Apply link" />
                <UButton v-if="editor.isActive('link')" size="xs" variant="ghost" icon="i-lucide-link-2-off" aria-label="Remove link" @click="linkHref = ''; applyLink()" />
              </form>
            </template>
          </UPopover>
        </template>
      </UEditorToolbar>
      <UEditorSuggestionMenu :editor="editor" :items="slashItems" :filter-fields="['label', 'keywords']" :limit="24" />
      <UEditorDragHandle
        v-if="editable"
        v-slot="{ ui, onClick }"
        :editor="editor"
        @node-change="handleNode = $event"
      >
        <UButton
          icon="i-lucide-plus"
          variant="ghost"
          size="xs"
          aria-label="Insert block below"
          :class="ui.handle()"
          @click.stop="insertBelow(editor, onClick)"
        />
        <UDropdownMenu
          v-slot="{ open }"
          :modal="false"
          :items="blockItems(editor)"
          :content="{ side: 'left', align: 'start' }"
          :ui="{ content: 'w-52' }"
          @update:open="lockHandle(editor, $event)"
        >
          <UButton
            icon="i-lucide-grip-vertical"
            variant="ghost"
            size="xs"
            active-variant="soft"
            aria-label="Block actions. Drag to move."
            :active="open"
            :class="ui.handle()"
            @click="onClick"
          />
        </UDropdownMenu>
      </UEditorDragHandle>
    </template>
    <div v-else class="vitehub-markdown-editor__content text-dimmed">Loading editor…</div>
    <ConsoleMediaDialog v-if="!providedPicker" ref="dialog" />
  </section>
</template>

<style>
.vitehub-markdown-editor__content {
  color: var(--ui-text);
  font-size: 0.9375rem;
  line-height: 1.6;
  min-height: 40vh;
  outline: none;
  padding-bottom: 30vh;
}

.vitehub-markdown-editor__content > * + * { margin-top: 0.625rem; }
.vitehub-markdown-editor__content > :first-child { margin-top: 0; }

.vitehub-markdown-editor__content :is(h1, h2, h3, h4) {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}

.vitehub-markdown-editor__content h1 { font-size: 1.5rem; letter-spacing: -0.02em; line-height: 2rem; margin-top: 2rem; }
.vitehub-markdown-editor__content h2 { font-size: 1.25rem; letter-spacing: -0.01em; line-height: 1.75rem; margin-top: 1.75rem; }
.vitehub-markdown-editor__content h3 { font-size: 1.0625rem; line-height: 1.5rem; margin-top: 1.25rem; }
.vitehub-markdown-editor__content h4 { font-size: 0.9375rem; margin-top: 1rem; }

.vitehub-markdown-editor__content :is(ul, ol) { padding-inline-start: 1.5rem; }
.vitehub-markdown-editor__content ul { list-style: disc; }
.vitehub-markdown-editor__content ol { list-style: decimal; }
.vitehub-markdown-editor__content li { margin-block: 0.125rem; padding-inline-start: 0.25rem; }
.vitehub-markdown-editor__content li::marker { color: var(--ui-text-dimmed); }

.vitehub-markdown-editor__content blockquote {
  border-inline-start: 2px solid var(--ui-text-highlighted);
  padding-inline-start: 1rem;
}

.vitehub-markdown-editor__content a {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-decoration-color: var(--ui-border-accented);
  text-underline-offset: 3px;
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
  border-radius: 0.5rem;
  box-shadow: inset 0 0 0 1px var(--ui-border);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.25rem;
  overflow-x: auto;
  padding: 0.75rem 1rem;
}

.vitehub-markdown-editor__content pre code { background: none; padding: 0; }

.vitehub-markdown-editor__content hr {
  border: 0;
  border-top: 1px solid var(--ui-border);
  margin-block: 1.5rem;
}

.vitehub-markdown-editor__content table { border-collapse: collapse; margin-block: 1rem; table-layout: fixed; width: 100%; }
.vitehub-markdown-editor__content :is(th, td) {
  border: 1px solid var(--ui-border);
  padding: 0.375rem 0.625rem;
  position: relative;
  text-align: start;
  vertical-align: top;
}
.vitehub-markdown-editor__content th { background: var(--ui-bg-elevated); font-weight: 500; }
.vitehub-markdown-editor__content .selectedCell::after {
  background: color-mix(in oklab, var(--ui-primary) 12%, transparent);
  content: "";
  inset: 0;
  pointer-events: none;
  position: absolute;
}
.vitehub-markdown-editor__content .column-resize-handle { background: var(--ui-primary); bottom: 0; position: absolute; right: -1px; top: 0; width: 2px; }

.vitehub-markdown-editor__content img { border-radius: 0.375rem; display: inline-block; max-width: 100%; }
.vitehub-markdown-editor__content img.ProseMirror-selectednode { outline: 2px solid var(--ui-primary); outline-offset: 2px; }

/* The block that the handle selected gets a tint, as in Notion. */
.vitehub-markdown-editor__content .ProseMirror-selectednode:not(img) {
  background: color-mix(in oklab, var(--ui-primary) 10%, transparent);
  border-radius: 0.25rem;
}

.vitehub-markdown-editor__content ::selection { background: color-mix(in oklab, var(--ui-primary) 22%, transparent); }

/* Placeholder on the empty line with the cursor. */
.vitehub-markdown-editor__content :is(p, h1, h2, h3, h4).is-empty::before {
  color: var(--ui-text-dimmed);
  content: attr(data-placeholder);
  float: inline-start;
  height: 0;
  pointer-events: none;
}

.vitehub-markdown-editor__content[contenteditable="false"] :is(p, h1, h2, h3, h4).is-empty::before { content: none; }
</style>
