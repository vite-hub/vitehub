// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createViteHubUI, CopyButton, useCopy } from "../src/index.ts";

const ButtonStub = defineComponent({
  setup(_props, { attrs }) {
    return () => h("button", { ...attrs, "data-stub": "UButton" });
  },
});

function useClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

function mountButton(props: InstanceType<typeof CopyButton>["$props"], plugins: ReturnType<typeof createViteHubUI>[] = []) {
  return mount(() => h(CopyButton, props), { attachTo: document.body, global: { components: { UButton: ButtonStub }, plugins } });
}

const announcement = () => document.querySelector("[data-slot=live-announcer]");

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("CopyButton", () => {
  it("is an icon-only ghost button named Copy, with the theme copy icon", () => {
    const wrapper = mountButton({ value: "pnpm test" });
    const button = wrapper.get("[data-slot=copy-button]");
    expect(button.attributes()).toMatchObject({ "aria-label": "Copy", icon: "i-lucide-copy", variant: "ghost" });
    expect(button.attributes("label")).toBeUndefined();
    // The live region exists before the first copy, so the first announcement is read.
    expect(announcement()?.getAttribute("aria-live")).toBe("polite");
  });

  it("uses the label as the name, and an aria-label over both", () => {
    expect(mountButton({ value: "x", label: "Copy run ID" }).get("button").attributes("aria-label")).toBeUndefined();
    expect(mountButton({ value: "x", label: "Copy", ariaLabel: "Copy the run ID" }).get("button").attributes("aria-label")).toBe("Copy the run ID");
  });

  it("reads the icons from the app config", () => {
    const wrapper = mountButton({ value: "x" }, [createViteHubUI({ icons: { copy: "i-ph-copy", copyCheck: "i-ph-check" } })]);
    expect(wrapper.get("button").attributes("icon")).toBe("i-ph-copy");
  });

  it("shows its own resting icon, and the theme check after a copy", async () => {
    useClipboard(() => Promise.resolve());
    const wrapper = mountButton({ value: "https://vitehub.dev", icon: "i-lucide-link", label: "Copy link" });
    expect(wrapper.get("button").attributes("icon")).toBe("i-lucide-link");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get("button").attributes("icon")).toBe("i-lucide-check");
  });

  it("copies a string, shows the check for 2 seconds, and announces it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    const wrapper = mountButton({ value: "pnpm test" });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("pnpm test");
    expect(wrapper.get("button").attributes()).toMatchObject({ "data-copied": "", icon: "i-lucide-check", "aria-label": "Copy" });
    await vi.waitFor(() => expect(announcement()?.textContent).toBe("Copied"));
    expect(wrapper.emitted()).not.toHaveProperty("error");

    vi.advanceTimersByTime(2_000);
    await flushPromises();
    expect(wrapper.get("button").attributes("icon")).toBe("i-lucide-copy");
    expect(wrapper.get("button").attributes("data-copied")).toBeUndefined();
    expect(announcement()?.textContent).toBe("");
  });

  it("copies the text that a function returns, also from a promise", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    await mountButton({ value: () => "from a function" }).get("button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith("from a function");

    let resolve: (text: string) => void = () => {};
    const wrapper = mountButton({ value: () => new Promise<string>((done) => (resolve = done)) });
    await wrapper.get("button").trigger("click");
    // The text loads first, so the button shows the loading icon until it is ready.
    expect(wrapper.get("button").attributes("loading")).toBe("true");
    resolve("from a promise");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith("from a promise");
    expect(wrapper.get("button").attributes("loading")).toBe("false");
  });

  it("keeps the copy icon and announces the failure when the clipboard refuses", async () => {
    useClipboard(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
    const onCopy = vi.fn();
    const onError = vi.fn();
    const wrapper = mountButton({ value: "x", onCopy, onError });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get("button").attributes("icon")).toBe("i-lucide-copy");
    await vi.waitFor(() => expect(announcement()?.textContent).toBe("Copy failed"));
    expect(onError).toHaveBeenCalledOnce();
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("fails without a clipboard and when the function throws", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const { copy, failed } = useCopy();
    await expect(copy("x")).resolves.toBe(false);
    expect(failed.value).toBe(true);

    useClipboard(() => Promise.resolve());
    await expect(copy(() => { throw new Error("No text"); })).resolves.toBe(false);
    await expect(copy(() => Promise.reject(new Error("No text")))).resolves.toBe(false);
  });

  it("falls back to the copy command when the clipboard API is missing or refuses", async () => {
    const copied: string[] = [];
    const execCommand = vi.fn((command: string) => {
      const area = document.activeElement;
      if (command === "copy" && area instanceof HTMLTextAreaElement) copied.push(area.value.slice(area.selectionStart, area.selectionEnd));
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const trigger = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    try {
      const { copy } = useCopy();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      await expect(copy("without a clipboard")).resolves.toBe(true);
      useClipboard(() => Promise.reject(new DOMException("Insecure context", "NotAllowedError")));
      await expect(copy(() => Promise.resolve("after a refusal"))).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(copied).toEqual(["without a clipboard", "after a refusal"]);
      // The hidden text area is gone, and focus is back where it was.
      expect(document.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(trigger);

      execCommand.mockReturnValue(false);
      await expect(copy("refused")).resolves.toBe(false);
      await expect(copy(() => Promise.reject(new Error("No text")))).resolves.toBe(false);
      expect(execCommand).toHaveBeenCalledTimes(3);
    }
    finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("announces inside the dialog that holds the button", async () => {
    useClipboard(() => Promise.resolve());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    const wrapper = mount(() => h(CopyButton, { value: "x" }), { attachTo: dialog, global: { components: { UButton: ButtonStub } } });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(dialog.querySelector(":scope > [data-slot=live-announcer]")?.textContent).toBe("Copied"));
  });
});
