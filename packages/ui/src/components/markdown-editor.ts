import { createHandlers } from "@nuxt/ui/utils/editor";
import type { EditorSuggestionMenuItem, EditorToolbarItem } from "@nuxt/ui";
import type { AnyExtension } from "@tiptap/core";
import { type Editor, EditorContent } from "@tiptap/vue-3";
import { uploadFiles } from "@vite-hub/blob/client";
import { typesetCss } from "comark-ui";
import { chooseFiles, uploadKey, uploadPlugin, type UploadOptions } from "comark-ui/editor";
import { useComarkEditor, type UseComarkEditorOptions } from "comark-ui/editor/vue";
import { computed, defineComponent, h, provide, ref, shallowRef, watch, watchEffect, type PropType } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/** Sends one file and resolves with the URL the document links to. Call `progress` with a fraction from 0 to 1. */
export type MarkdownEditorUpload = (file: File, progress: (fraction: number) => void) => Promise<string>;

/**
 * Uploads to a route that returns the result of `blob.handleUpload()`, with progress, and resolves with the stored
 * object's URL. The Blob store has to be served (`blob.serve`), so the object has a URL to link.
 */
export function blobUpload(route: string): MarkdownEditorUpload {
  return async (file, progress) => {
    const [object] = await uploadFiles(route, [file], { onProgress: (percent) => progress(percent / 100) });
    if (!object?.url) throw new Error(`${route} stored ${file.name} without a URL. Serve the Blob store with \`blob.serve\` so the editor can link it.`);
    return object.url;
  };
}

const toolbar: EditorToolbarItem[][] = [
  [
    { kind: "mark", mark: "bold", icon: "i-ph-text-b", "aria-label": "Bold" },
    { kind: "mark", mark: "italic", icon: "i-ph-text-italic", "aria-label": "Italic" },
    { kind: "mark", mark: "strike", icon: "i-ph-text-strikethrough", "aria-label": "Strikethrough" },
    { kind: "mark", mark: "code", icon: "i-ph-code", "aria-label": "Code" },
  ],
  [
    { kind: "heading", level: 1, icon: "i-ph-text-h-one", "aria-label": "Heading 1" },
    { kind: "heading", level: 2, icon: "i-ph-text-h-two", "aria-label": "Heading 2" },
    { kind: "heading", level: 3, icon: "i-ph-text-h-three", "aria-label": "Heading 3" },
  ],
  [
    { kind: "bulletList", icon: "i-ph-list-bullets", "aria-label": "Bulleted list" },
    { kind: "orderedList", icon: "i-ph-list-numbers", "aria-label": "Numbered list" },
    { kind: "blockquote", icon: "i-ph-quotes", "aria-label": "Quote" },
  ],
];

const blocks: EditorSuggestionMenuItem[] = [
  { type: "label", label: "Blocks" },
  { kind: "paragraph", label: "Text", icon: "i-ph-text-t" },
  { kind: "heading", level: 1, label: "Heading 1", icon: "i-ph-text-h-one" },
  { kind: "heading", level: 2, label: "Heading 2", icon: "i-ph-text-h-two" },
  { kind: "heading", level: 3, label: "Heading 3", icon: "i-ph-text-h-three" },
  { kind: "bulletList", label: "Bulleted list", icon: "i-ph-list-bullets" },
  { kind: "orderedList", label: "Numbered list", icon: "i-ph-list-numbers" },
  { kind: "blockquote", label: "Quote", icon: "i-ph-quotes" },
  { kind: "codeBlock", label: "Code block", icon: "i-ph-code-block" },
  { kind: "horizontalRule", label: "Divider", icon: "i-ph-minus" },
];
const image: EditorSuggestionMenuItem = { kind: "image", label: "Image", description: "Upload an image, video, or audio file", icon: "i-ph-image" };

/**
 * A Markdown editor on comark-ui's editor, with Nuxt UI's bubble toolbar, "/" menu, and drag handle. Bind Markdown with
 * `v-model`, or pass an `editor` the app made, such as a Realtime room's. With `upload`, pasted and dropped files and the
 * "/" menu's Image item upload with a placeholder that shows the percentage; a string is a Blob upload route.
 */
export const MarkdownEditor = defineComponent({
  name: "MarkdownEditor",
  inheritAttrs: false,
  // `editor` is read once: an editor bound to `modelValue` is made at mount when no `editor` is given.
  props: {
    modelValue: { type: String, default: undefined },
    /** An editor the app made, used instead of one bound to `modelValue`. */
    editor: { type: Object as PropType<Editor>, default: undefined },
    /** A Blob upload route, such as `/api/uploads`, or a function that uploads one file and resolves with its URL. */
    upload: { type: [String, Function] as PropType<string | MarkdownEditorUpload>, default: undefined },
    /** Which files to take. Images, video, and audio by default. */
    accept: { type: Function as PropType<(file: File) => boolean>, default: undefined },
    /** Parse plugins the page renders with, so a document only they read opens read-only. */
    plugins: { type: Array as PropType<NonNullable<UseComarkEditorOptions["plugins"]>>, default: undefined },
    /** Extra Tiptap extensions for the editor bound to `modelValue`. */
    extensions: { type: Array as PropType<AnyExtension[]>, default: undefined },
  },
  emits: {
    "update:modelValue": (_value: string) => true,
    /** An upload failed; its placeholder is gone. */
    uploadError: (_error: unknown, _file: File) => true,
  },
  setup(props, { attrs, emit, slots }) {
    const UEditorToolbar = useUIComponent("UEditorToolbar");
    const UEditorSuggestionMenu = useUIComponent("UEditorSuggestionMenu");
    const UEditorDragHandle = useUIComponent("UEditorDragHandle");

    const markdown = ref(props.modelValue ?? "");
    watch(() => props.modelValue, (value) => {
      if (value !== undefined) markdown.value = value;
    });
    watch(markdown, (value) => {
      if (value !== props.modelValue) emit("update:modelValue", value);
    });
    // The bound editor exists only without an `editor` prop: a Realtime room owns its own content.
    const own = props.editor ? undefined : useComarkEditor(markdown, { extensions: props.extensions, plugins: props.plugins });
    const editor = computed(() => props.editor ?? own?.editor.value);

    const options = shallowRef<UploadOptions>();
    watchEffect(() => {
      const send = typeof props.upload === "string" ? blobUpload(props.upload) : props.upload;
      options.value = send && {
        upload: send,
        accept: props.accept ?? ((file) => /^(?:image|video|audio)\//.test(file.type)),
        onError: (error, file) => emit("uploadError", error, file),
      };
    });
    // The upload plugin goes on whichever editor shows, so an app's editor gets paste, drop, and progress too.
    watch([editor, options], ([current, upload], _, onCleanup) => {
      if (!current || !upload || uploadKey.getState(current.state)) return;
      current.registerPlugin(uploadPlugin(upload));
      onCleanup(() => {
        if (!current.isDestroyed) current.unregisterPlugin(uploadKey);
      });
    }, { immediate: true });

    // Nuxt UI's menus run an item's `kind` through these handlers. Image opens the file picker instead of asking for a URL.
    const handlers = computed(() => ({
      ...createHandlers(),
      image: {
        canExecute: () => Boolean(options.value),
        execute: (current: Editor) => ({ run: () => (options.value ? chooseFiles(current.view, options.value) : false) }),
        isActive: () => false,
        isDisabled: () => !options.value,
      },
    }));
    provide("editorHandlers", handlers);

    const menu = computed(() => (options.value ? [...blocks, image] : blocks));

    return () => {
      const current = editor.value;
      if (!current) return null;
      return h("div", { ...attrs, class: ["vh-markdown-editor", attrs.class] }, [
        // The typeset scopes to this wrapper, so the text reads as `Markdown` renders it.
        h("div", { class: "vh-markdown-editor-content" }, [
          h("style", { "data-comark-typeset": "", innerHTML: typesetCss }),
          h(EditorContent, { editor: current }),
        ]),
        h(UEditorToolbar, { editor: current, items: toolbar, layout: "bubble" }),
        h(UEditorSuggestionMenu, { editor: current, items: menu.value }),
        h(UEditorDragHandle, { editor: current }),
        slots.default?.({ editor: current }),
      ]);
    };
  },
});
