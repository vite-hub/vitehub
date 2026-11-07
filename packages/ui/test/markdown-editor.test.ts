// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { uploadKey } from "comark-ui/editor";
import { defineComponent, h, inject, type ComputedRef } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/vue-3";
import StarterKit from "@tiptap/starter-kit";
import { blobUpload, MarkdownEditor } from "../src/markdown-editor.ts";

interface Handler { execute: (editor: Editor) => { run: () => unknown }, isDisabled?: () => boolean }
interface Item { kind?: string, label?: string }

// Nuxt UI's editor menus, reduced to what they receive: the editor, the items, and the handlers they run items through.
const seen: { items?: Item[], handlers?: ComputedRef<Record<string, Handler>> } = {};
const SuggestionMenu = defineComponent({
  props: { editor: Object, items: Array },
  setup(props) {
    seen.handlers = inject("editorHandlers");
    return () => {
      // SAFETY: the test passes the menu its items as plain objects.
      seen.items = props.items as Item[];
      return h("div", { "data-menu": "" });
    };
  },
});
const Stub = defineComponent({ props: { editor: Object, items: Array, layout: String }, setup: () => () => null });
const global = { components: { UEditorDragHandle: Stub, UEditorSuggestionMenu: SuggestionMenu, UEditorToolbar: Stub } };

async function mounted(props: Record<string, unknown>) {
  const wrapper = mount(MarkdownEditor, { attachTo: document.body, global, props: { modelValue: "Hello\n", ...props } });
  await vi.waitFor(() => expect(wrapper.find(".ProseMirror").exists()).toBe(true));
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("MarkdownEditor", () => {
  it.each(["owned", "external"])("keeps the initial %s editor when the prop changes or clears", async (mode) => {
    const external = new Editor({ extensions: [StarterKit], content: "<p>Shared document</p>" });
    const replacement = new Editor({ extensions: [StarterKit], content: "<p>Another document</p>" });
    const wrapper = await mounted({ editor: mode === "external" ? external : undefined });
    const initial = wrapper.findComponent(SuggestionMenu).props("editor");
    try {
      expect(wrapper.find(".ProseMirror").element.closest(".vh-typeset")).not.toBeNull();
      expect(wrapper.find(".ProseMirror").text()).toBe(mode === "external" ? "Shared document" : "Hello");
      await wrapper.setProps({ editor: replacement });
      await flushPromises();
      expect(wrapper.findComponent(SuggestionMenu).props("editor") === initial).toBe(true);
      await wrapper.setProps({ editor: undefined });
      await flushPromises();
      expect(wrapper.findComponent(SuggestionMenu).props("editor") === initial).toBe(true);
      expect(wrapper.find(".ProseMirror").text()).toBe(mode === "external" ? "Shared document" : "Hello");
    } finally {
      wrapper.unmount();
      external.destroy();
      replacement.destroy();
    }
  });

  it("edits the bound Markdown without an upload, and offers no Image item", async () => {
    const wrapper = await mounted({});
    expect(wrapper.find(".ProseMirror").text()).toBe("Hello");
    expect(seen.items?.map((item) => item.kind)).not.toContain("image");
    expect(seen.handlers?.value.image?.isDisabled?.()).toBe(true);
    wrapper.unmount();
  });

  it("turns on paste, drop, and the Image item with an upload", async () => {
    const upload = vi.fn(async () => "/f/shot.png");
    const wrapper = await mounted({ upload });
    expect(seen.items?.at(-1)).toMatchObject({ kind: "image", label: "Image" });

    // The Image item opens the file picker; the picked file uploads at the cursor.
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = create(tag);
      if (tag === "input") {
        Object.defineProperty(element, "files", { value: [png] });
        element.click = () => element.dispatchEvent(new Event("change"));
      }
      return element;
    });
    // SAFETY: the bound editor is the one MarkdownEditor renders; Tiptap keeps it on its EditorContent element.
    const editor = (wrapper.find(".ProseMirror").element as HTMLElement & { editor: Editor }).editor;
    expect(uploadKey.getState(editor.state)).toBeDefined();
    seen.handlers!.value.image!.execute(editor).run();
    await vi.waitFor(() => expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["![shot.png](/f/shot.png)Hello\n"]));
    expect(upload).toHaveBeenCalledWith(png, expect.any(Function));
    vi.restoreAllMocks();
    wrapper.unmount();
  });
});

describe("blobUpload", () => {
  function xhr(status: number, body: unknown) {
    class FakeXhr {
      status = 0;
      responseText = "";
      private load: Array<() => void> = [];
      private progress: Array<(event: { lengthComputable: boolean, loaded: number, total: number }) => void> = [];
      upload = { addEventListener: (_type: string, listener: (event: { lengthComputable: boolean, loaded: number, total: number }) => void) => this.progress.push(listener) };
      open() {}
      setRequestHeader() {}
      getResponseHeader() { return "application/json"; }
      addEventListener(type: string, listener: () => void) { if (type === "load") this.load.push(listener); }
      send() {
        for (const listener of this.progress) listener({ lengthComputable: true, loaded: 1, total: 4 });
        this.status = status;
        this.responseText = JSON.stringify(body);
        for (const listener of this.load) listener();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  }
  const stored = { customMetadata: {}, httpMetadata: {}, pathname: "shot.png", uploadedAt: "2026-11-05T00:00:00.000Z" };
  const file = new File(["x"], "shot.png", { type: "image/png" });

  it("uploads to a Blob route with progress and links the served URL", async () => {
    xhr(200, [{ ...stored, url: "/assets/shot.png" }]);
    const progress: number[] = [];
    await expect(blobUpload("/api/uploads")(file, (fraction) => progress.push(fraction))).resolves.toBe("/assets/shot.png");
    expect(progress).toEqual([0.25]);
  });

  it("says to serve the store when the object has no URL", async () => {
    xhr(200, [stored]);
    await expect(blobUpload("/api/uploads")(file, () => {})).rejects.toThrow("Serve the Blob store with `blob.serve`");
  });
});
