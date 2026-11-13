// @vitest-environment happy-dom
import { h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import {
  Editable,
  EditableArea,
  EditableCancelTrigger,
  EditableEditTrigger,
  EditableInput,
  EditablePreview,
  EditableSubmitTrigger,
} from "@vite-hub/kit/editable";

import { click, mount, one, press, settle, type } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function render(value: Ref<string>, props: Record<string, unknown> = {}) {
  const view = mount(() =>
    h("form", null, [
      h(
        Editable,
        { modelValue: value.value, "onUpdate:modelValue": (next: string) => (value.value = next), ...props },
        () => [
          h(EditableArea, null, () => [h(EditablePreview), h(EditableInput, { "aria-label": "Title" })]),
          h(EditableEditTrigger, null, () => "Edit"),
          h(EditableSubmitTrigger, null, () => "Save"),
          h(EditableCancelTrigger, null, () => "Cancel"),
        ],
      ),
      h("button", { type: "button", id: "outside" }, "Outside"),
    ]),
  );
  cleanup = view.unmount;
  const find = (part: string) => view.host.querySelector<HTMLElement>(`[data-slot="editable-${part}"]`);
  const input = () => find("input") as HTMLInputElement | null;
  return { ...view, find, input, preview: find("preview")! };
}

describe("Editable", () => {
  it("shows the value in a focusable preview until editing starts", async () => {
    const { preview, input, find } = render(ref("Draft"), { placeholder: "Untitled" });
    expect(preview.textContent).toBe("Draft");
    expect(preview.getAttribute("tabindex")).toBe("0");
    expect(input()).toBeNull();
    expect(find("submit-trigger")).toBeNull();
    expect(find("cancel-trigger")).toBeNull();
    expect(find("edit-trigger")!.hasAttribute("hidden")).toBe(false);
  });

  it("shows the placeholder while the value is empty", async () => {
    const { preview, host } = render(ref(""), { placeholder: "Untitled" });
    expect(preview.textContent).toBe("Untitled");
    expect(one(host, '[data-slot="editable"]').hasAttribute("data-empty")).toBe(true);
  });

  it("starts editing on focus, saves on Enter, and gives focus back to the preview", async () => {
    const value = ref("Draft");
    const { preview, input, host } = render(value);
    preview.focus();
    await settle();
    const field = input()!;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Draft");
    expect(preview.hasAttribute("hidden")).toBe(true);
    expect(one(host, '[data-slot="editable"]').hasAttribute("data-editing")).toBe(true);

    field.value = "";
    await type(field, "Final");
    await press(field, "Enter");
    expect(value.value).toBe("Final");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(preview);
    expect(preview.textContent).toBe("Final");
  });

  it("puts the text back on Escape", async () => {
    const value = ref("Draft");
    const { preview, input } = render(value);
    preview.focus();
    await settle();
    await type(input()!, " more");
    await press(input()!, "Escape");
    expect(value.value).toBe("Draft");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(preview);
  });

  it("saves when focus leaves, but not when it moves to its own triggers", async () => {
    const value = ref("Draft");
    const { preview, input, find, host } = render(value);
    preview.focus();
    await settle();
    await type(input()!, "!");
    find("cancel-trigger")!.focus();
    await settle();
    expect(input()).not.toBeNull();
    one(host, "#outside").focus();
    await settle();
    expect(value.value).toBe("Draft!");
    expect(input()).toBeNull();
  });

  it("starts editing on a double click, Enter, F2, or a typed key in dblclick mode", async () => {
    const value = ref("Draft");
    const { preview, input } = render(value, { activationMode: "dblclick" });
    preview.focus();
    await settle();
    expect(input()).toBeNull();

    preview.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(input()).not.toBeNull();
    await press(input()!, "Escape");

    await press(preview, "F2");
    expect(input()!.value).toBe("Draft");
    await press(input()!, "Escape");

    await press(preview, "x");
    expect(input()!.value).toBe("x");
  });

  it("saves and cancels from its triggers", async () => {
    const value = ref("Draft");
    const { find, input } = render(value, { activationMode: "none" });
    // A click focuses a button in a browser, which happy-dom does not do.
    find("edit-trigger")!.focus();
    await click(find("edit-trigger")!);
    expect(find("edit-trigger")!.hasAttribute("hidden")).toBe(true);
    await type(input()!, "!");
    await click(find("submit-trigger")!);
    expect(value.value).toBe("Draft!");
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(find("edit-trigger"));

    find("edit-trigger")!.focus();
    await click(find("edit-trigger")!);
    await type(input()!, "?");
    await click(find("cancel-trigger")!);
    expect(value.value).toBe("Draft!");
  });

  it("only saves from the submit trigger with submitMode none", async () => {
    const value = ref("Draft");
    const { preview, input, host } = render(value, { submitMode: "none" });
    preview.focus();
    await settle();
    await type(input()!, "!");
    await press(input()!, "Enter");
    expect(input()).not.toBeNull();
    one(host, "#outside").focus();
    await settle();
    expect(value.value).toBe("Draft");
    expect(input()).toBeNull();
  });

  it("starts in edit mode with defaultEditing", async () => {
    const { input } = render(ref("Draft"), { defaultEditing: true });
    await settle();
    expect(document.activeElement).toBe(input());
    expect(input()!.value).toBe("Draft");
  });

  it("never edits while disabled or read only", async () => {
    for (const props of [{ disabled: true }, { readOnly: true }]) {
      const { preview, input, find, unmount } = render(ref("Draft"), props);
      preview.focus();
      await press(preview, "Enter");
      expect(input()).toBeNull();
      expect(find("edit-trigger")!.hasAttribute("disabled")).toBe(true);
      unmount();
      cleanup = undefined;
    }
  });

  it("submits the value under its name", async () => {
    const { host } = render(ref("Draft"), { name: "title" });
    expect(new FormData(one<HTMLFormElement>(host, "form")).get("title")).toBe("Draft");
  });
});
