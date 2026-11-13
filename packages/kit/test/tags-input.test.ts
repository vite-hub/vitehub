// @vitest-environment happy-dom
import { h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@vite-hub/kit/tags-input";

import { click, mount, one, press, type } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function render(tags: Ref<string[]>, props: Record<string, unknown> = {}) {
  const view = mount(() =>
    h("form", null, h(
      TagsInput,
      { modelValue: tags.value, "onUpdate:modelValue": (value: string[]) => (tags.value = value), ...props },
      () => [
        ...tags.value.map((tag) =>
          h(TagsInputItem, { key: tag, value: tag }, () => [
            h(TagsInputItemText, null, () => tag),
            h(TagsInputItemDelete, null, () => "Remove"),
          ]),
        ),
        h(TagsInputInput, { "aria-label": "Tags" }),
        h(TagsInputClear, null, () => "Clear"),
      ],
    )),
  );
  cleanup = view.unmount;
  const input = one<HTMLInputElement>(view.host, '[data-slot="tags-input-input"]');
  const items = () => [...view.host.querySelectorAll<HTMLElement>('[data-slot="tags-input-item"]')];
  const highlighted = () => items().find((item) => item.hasAttribute("data-highlighted"))?.textContent;
  input.focus();
  return { ...view, input, items, highlighted };
}

describe("TagsInput", () => {
  it("adds the typed text as a tag on Enter, and lets an empty Enter submit", async () => {
    const tags = ref<string[]>([]);
    const { input } = render(tags);
    await type(input, "  vue ");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(tags.value).toEqual(["vue"]);
    expect(input.value).toBe("");

    const empty = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(false);
  });

  it.each([false, true])("commits on Tab without canceling navigation (shift=%s)", async (shiftKey) => {
    const tags = ref<string[]>([]);
    const { input } = render(tags, { addOnTab: true });
    await type(input, "vue");
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    input.dispatchEvent(tab);
    expect(tags.value).toEqual(["vue"]);
    expect(input.value).toBe("");
    expect(tab.defaultPrevented).toBe(false);
  });

  it.each([false, true])("keeps refused delimiter input (cancel=%s)", async (cancel) => {
    const tags = ref(["vue"]);
    const { input } = render(tags, cancel
      ? { onValueChange: (_value: string[], details: { cancel: () => void }) => details.cancel() }
      : { max: 1 });
    await type(input, "nuxt,");
    expect(tags.value).toEqual(["vue"]);
    expect(input.value).toBe("nuxt,");
  });

  it.each([false, true])("keeps refused pasted text (cancel=%s)", async (cancel) => {
    const tags = ref(["vue"]);
    const { input } = render(tags, { addOnPaste: true, ...(cancel
      ? { onValueChange: (_value: string[], details: { cancel: () => void }) => details.cancel() }
      : { max: 1 }) });
    const data = new DataTransfer();
    data.setData("text", "nuxt,vite");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    expect(tags.value).toEqual(["vue"]);
    expect(input.value).toBe("nuxt,vite");
  });

  it.each([false, true])("retains only refused entries in a partial batch (paste=%s)", async (paste) => {
    const tags = ref<string[]>([]);
    const { input } = render(tags, { max: 1, addOnPaste: true });
    if (paste) {
      const data = new DataTransfer();
      data.setData("text", "vue,nuxt,vite");
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      input.value = "vue,nuxt,vite,";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    expect(tags.value).toEqual(["vue"]);
    expect(input.value).toBe(paste ? "nuxt,vite" : "nuxt,vite,");
  });

  it("adds a tag when the delimiter is typed", async () => {
    const tags = ref<string[]>([]);
    const { input } = render(tags, { delimiter: ";" });
    await type(input, "nuxt;vite;re");
    expect(tags.value).toEqual(["nuxt", "vite"]);
    expect(input.value).toBe("re");
  });

  it("refuses a tag that exists or doesn't fit, until the person types again", async () => {
    const tags = ref(["vue"]);
    const { input, host } = render(tags, { max: 2 });
    await type(input, "vue");
    await press(input, "Enter");
    expect(tags.value).toEqual(["vue"]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(one(host, '[data-slot="tags-input"]').hasAttribute("data-invalid")).toBe(true);

    input.value = "";
    await type(input, "nuxt");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    await press(input, "Enter");
    await type(input, "vite");
    await press(input, "Enter");
    expect(tags.value).toEqual(["vue", "nuxt"]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("removes the last tag on Backspace in an empty input", async () => {
    const tags = ref(["vue", "nuxt"]);
    const { input } = render(tags);
    await press(input, "Backspace");
    expect(tags.value).toEqual(["vue"]);

    await type(input, "x");
    await press(input, "Backspace");
    expect(tags.value).toEqual(["vue"]);
  });

  it("moves a highlight between tags with the arrow keys, and removes the highlighted tag", async () => {
    const tags = ref(["vue", "nuxt", "vite"]);
    const { input, items, highlighted } = render(tags);
    await press(input, "ArrowRight");
    expect(highlighted()).toBeUndefined();

    await press(input, "ArrowLeft");
    expect(highlighted()).toBe("viteRemove");
    expect(items()[2]!.getAttribute("aria-current")).toBe("true");
    await press(input, "ArrowLeft");
    await press(input, "ArrowLeft");
    await press(input, "ArrowLeft");
    expect(highlighted()).toBe("vueRemove");
    await press(input, "ArrowRight");
    expect(highlighted()).toBe("nuxtRemove");
    expect(document.activeElement).toBe(input);

    await press(input, "Delete");
    expect(tags.value).toEqual(["vue", "vite"]);
    expect(highlighted()).toBe("viteRemove");
    await press(input, "Backspace");
    expect(tags.value).toEqual(["vue"]);
    expect(highlighted()).toBe("vueRemove");

    await press(input, "ArrowRight");
    expect(highlighted()).toBeUndefined();
    await press(input, "ArrowLeft");
    await press(input, "Escape");
    expect(highlighted()).toBeUndefined();
  });

  it("swaps the arrow keys in right to left text", async () => {
    const tags = ref(["vue", "nuxt"]);
    const { input, highlighted } = render(tags, { dir: "rtl", style: "direction: rtl" });
    await press(input, "ArrowLeft");
    expect(highlighted()).toBeUndefined();
    await press(input, "ArrowRight");
    expect(highlighted()).toBe("nuxtRemove");
  });

  it("names each delete button after its tag and keeps it out of the tab order", async () => {
    const tags = ref(["vue", "nuxt"]);
    const { host } = render(tags);
    const remove = host.querySelectorAll<HTMLButtonElement>('[data-slot="tags-input-item-delete"]')[1]!;
    expect(remove.getAttribute("tabindex")).toBe("-1");
    const names = remove.getAttribute("aria-labelledby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(names).toEqual(["Remove", "nuxt"]);

    await click(remove);
    expect(tags.value).toEqual(["vue"]);
  });

  it("clears every tag", async () => {
    const tags = ref(["vue", "nuxt"]);
    const { host } = render(tags);
    await click(one(host, '[data-slot="tags-input-clear"]'));
    expect(tags.value).toEqual([]);
  });

  it("adds pasted text as tags with addOnPaste", async () => {
    const tags = ref<string[]>([]);
    const { input } = render(tags, { addOnPaste: true });
    const data = new DataTransfer();
    data.setData("text", "a, b ,c");
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(tags.value).toEqual(["a", "b", "c"]);
  });

  it("submits each tag under its name", async () => {
    const tags = ref(["vue", "nuxt"]);
    const { host } = render(tags, { name: "stack" });
    expect(new FormData(one<HTMLFormElement>(host, "form")).getAll("stack")).toEqual(["vue", "nuxt"]);
  });

  it("does nothing while disabled", async () => {
    const tags = ref(["vue"]);
    const { input, host } = render(tags, { disabled: true });
    expect(input.disabled).toBe(true);
    await press(input, "Backspace");
    await click(one(host, '[data-slot="tags-input-item-delete"]'));
    expect(tags.value).toEqual(["vue"]);
    expect(one(host, '[data-slot="tags-input-item"]').hasAttribute("data-disabled")).toBe(true);
  });
});
