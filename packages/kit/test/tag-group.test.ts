// @vitest-environment happy-dom
import { h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { TagGroup, TagGroupItem, TagGroupItemRemove } from "@vite-hub/kit/tag-group";

import { click, mount, press, settle } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function render(tags: Ref<string[]>, selected: Ref<string[]>, props: Record<string, unknown> = {}) {
  const view = mount(() =>
    h(
      TagGroup,
      {
        "aria-label": "Frameworks",
        modelValue: selected.value,
        "onUpdate:modelValue": (value: string[]) => (selected.value = value),
        onRemove: (values: string[]) => (tags.value = tags.value.filter((tag) => !values.includes(tag))),
        ...props,
      },
      () =>
        tags.value.map((tag) =>
          h(TagGroupItem, { key: tag, value: tag, disabled: tag === "locked" }, () => [
            tag,
            h(TagGroupItemRemove, { "aria-label": `Remove ${tag}` }, () => "x"),
          ]),
        ),
    ),
  );
  cleanup = view.unmount;
  const grid = view.host.querySelector<HTMLElement>('[role="grid"]')!;
  const rows = () => [...grid.querySelectorAll<HTMLElement>('[role="row"]')];
  const row = (tag: string) => rows().find((el) => el.textContent?.startsWith(tag))!;
  return { ...view, grid, rows, row };
}

describe("TagGroup", () => {
  it("is a grid of rows, each with one cell, and one tab stop", async () => {
    const { grid, rows } = render(ref(["vue", "nuxt", "vite"]), ref([]));
    await settle();
    expect(grid.getAttribute("aria-label")).toBe("Frameworks");
    expect(grid.getAttribute("data-slot")).toBe("tag-group");
    expect(rows().map((row) => row.querySelectorAll(':scope > [role="gridcell"]').length)).toEqual([1, 1, 1]);
    expect(rows().map((row) => row.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(rows()[0]!.hasAttribute("aria-selected")).toBe(false);
    const remove = rows()[0]!.querySelector('[data-slot="tag-group-item-remove"]')!;
    expect(remove.getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus with the arrow keys, Home, and End", async () => {
    const { rows } = render(ref(["vue", "nuxt", "vite"]), ref([]));
    await settle();
    rows()[0]!.focus();
    await press(rows()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1]!, "ArrowDown");
    expect(document.activeElement).toBe(rows()[2]);
    await press(rows()[2]!, "ArrowLeft");
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1]!, "Home");
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0]!, "End");
    expect(document.activeElement).toBe(rows()[2]);
    expect(rows().map((row) => row.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("selects many tags with Space, Enter, and clicks", async () => {
    const selected = ref<string[]>([]);
    const { grid, row } = render(ref(["vue", "nuxt", "vite"]), selected, { selectionMode: "multiple" });
    await settle();
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    row("vue").focus();
    await press(row("vue"), " ");
    await click(row("vite"));
    expect(selected.value).toEqual(["vue", "vite"]);
    expect(row("vue").getAttribute("aria-selected")).toBe("true");
    expect(row("vue").hasAttribute("data-selected")).toBe(true);
    expect(row("nuxt").getAttribute("aria-selected")).toBe("false");
    await press(row("vue"), "Enter");
    expect(selected.value).toEqual(["vite"]);
  });

  it("selects one tag at a time in single mode", async () => {
    const selected = ref<string[]>([]);
    const { row } = render(ref(["vue", "nuxt"]), selected, { selectionMode: "single" });
    await click(row("vue"));
    await click(row("nuxt"));
    expect(selected.value).toEqual(["nuxt"]);
    await click(row("nuxt"));
    expect(selected.value).toEqual([]);
  });

  it("removes a tag with its button, without selecting it", async () => {
    const tags = ref(["vue", "nuxt"]);
    const selected = ref<string[]>([]);
    const { row } = render(tags, selected, { selectionMode: "multiple" });
    await click(row("vue").querySelector('[data-slot="tag-group-item-remove"]')!);
    expect(tags.value).toEqual(["nuxt"]);
    expect(selected.value).toEqual([]);
  });

  it("removes the focused tag with Delete or Backspace, and focuses the next one", async () => {
    const tags = ref(["vue", "nuxt", "vite"]);
    const { row } = render(tags, ref([]));
    await settle();
    row("nuxt").focus();
    await press(row("nuxt"), "Delete");
    expect(tags.value).toEqual(["vue", "vite"]);
    expect(document.activeElement).toBe(row("vite"));
    await press(row("vite"), "Backspace");
    expect(tags.value).toEqual(["vue"]);
    expect(document.activeElement).toBe(row("vue"));
  });

  it("keeps a disabled tag focusable, but never selects or removes it", async () => {
    const tags = ref(["vue", "locked"]);
    const selected = ref<string[]>([]);
    const { row } = render(tags, selected, { selectionMode: "multiple" });
    await settle();
    const locked = row("locked");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    row("vue").focus();
    await press(row("vue"), "ArrowRight");
    expect(document.activeElement).toBe(locked);
    await press(locked, " ");
    await press(locked, "Delete");
    expect(selected.value).toEqual([]);
    expect(tags.value).toEqual(["vue", "locked"]);
  });
});
