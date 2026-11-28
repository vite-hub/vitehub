// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton, useCopy } from "../src/index.ts";
import type { CopyButtonProps } from "../src/index.ts";

function useClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

type Listeners = { onCopy?: () => void; onError?: () => void; "aria-label"?: string };

function mountButton(props: CopyButtonProps & Listeners, slots: Record<string, () => unknown> = {}) {
  return mount(() => h(CopyButton, props, slots), { attachTo: document.body });
}

const announcement = () => document.querySelector("[data-slot=live-announcer]");
/** The Lucide icon that the button shows, such as `copy`, `check`, or `loader-circle`. */
const icon = (wrapper: ReturnType<typeof mountButton>) =>
  wrapper.get("[data-slot=copy-button-icon]").classes().find((name) => name.startsWith("lucide-"))?.slice("lucide-".length);

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("CopyButton", () => {
  it("keeps an explicit disabled attribute while idle", () => {
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    const button = mountButton({ value: "text", disabled: true }).get<HTMLButtonElement>("button").element;
    expect(button.disabled).toBe(true);
    button.click();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("is an icon-only small ghost button named Copy, with Lucide's copy icon", () => {
    const wrapper = mountButton({ value: "pnpm test" });
    const button = wrapper.get("button[data-slot=copy-button]");
    expect(button.attributes()).toMatchObject({ "aria-label": "Copy", "data-size": "sm", "data-variant": "ghost" });
    expect(icon(wrapper)).toBe("copy");
    expect(wrapper.find("[data-slot=copy-button-label]").exists()).toBe(false);
    // The live region exists before the first copy, so the first announcement is read.
    expect(announcement()?.getAttribute("aria-live")).toBe("polite");
  });

  it("uses the label as the name, and an aria-label over both", () => {
    expect(mountButton({ value: "x", label: "Copy run ID" }).get("button").attributes("aria-label")).toBeUndefined();
    expect(mountButton({ value: "x", label: "Copy", "aria-label": "Copy the run ID" }).get("button").attributes("aria-label")).toBe("Copy the run ID");
    expect(mountButton({ value: "x", copyLabel: "Kopieren" }).get("button").attributes("aria-label")).toBe("Kopieren");
  });

  it("shows the icon slot at rest, and the check and copiedLabel after a copy", async () => {
    useClipboard(() => Promise.resolve());
    const wrapper = mountButton({ value: "https://vitehub.dev", label: "Copy link" }, { icon: () => h("svg", { "data-slot": "copy-button-icon", class: "lucide-link" }) });
    expect(icon(wrapper)).toBe("link");
    expect(wrapper.get("[data-slot=copy-button-label]").text()).toBe("Copy link");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(icon(wrapper)).toBe("check");
    expect(wrapper.get("[data-slot=copy-button-label]").text()).toBe("Copied");
    const custom = mountButton({ value: "x", label: "Copy link", copiedLabel: "Link copied" });
    await custom.get("button").trigger("click");
    await flushPromises();
    expect(custom.get("[data-slot=copy-button-label]").text()).toBe("Link copied");
    await vi.waitFor(() => expect(announcement()?.textContent).toBe("Link copied"));
  });

  it("copies a string, shows the check for 2 seconds, and announces it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    const wrapper = mountButton({ value: "pnpm test" });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("pnpm test");
    expect(wrapper.get("button").attributes()).toMatchObject({ "data-copied": "", "aria-label": "Copy" });
    expect(icon(wrapper)).toBe("check");
    await vi.waitFor(() => expect(announcement()?.textContent).toBe("Copied"));
    expect(wrapper.emitted()).not.toHaveProperty("error");

    vi.advanceTimersByTime(2_000);
    await flushPromises();
    expect(icon(wrapper)).toBe("copy");
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
    expect(wrapper.get("button").attributes("disabled")).toBe("");
    resolve("from a promise");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith("from a promise");
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
  });

  it("keeps the copy icon and announces the failure when the clipboard refuses", async () => {
    useClipboard(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
    const onCopy = vi.fn();
    const onError = vi.fn();
    const wrapper = mountButton({ value: "x", onCopy, onError });

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(icon(wrapper)).toBe("copy");
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
    const wrapper = mount(() => h(CopyButton, { value: "x" }), { attachTo: dialog });
    await wrapper.get("button").trigger("click");
    await vi.waitFor(() => expect(dialog.querySelector(":scope > [data-slot=live-announcer]")?.textContent).toBe("Copied"));
  });

  it("shows the check for `duration` ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useClipboard(() => Promise.resolve());
    const wrapper = mountButton({ value: "x", duration: 500 });
    expect(wrapper.get("[data-slot=copy-button-icon]").attributes("aria-hidden")).toBe("true");

    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get("button").attributes("data-copied")).toBe("");
    expect(icon(wrapper)).toBe("check");

    vi.advanceTimersByTime(499);
    await flushPromises();
    expect(wrapper.get("button").attributes("data-copied")).toBe("");
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(wrapper.get("button").attributes("data-copied")).toBeUndefined();
    expect(icon(wrapper)).toBe("copy");
  });

  it("shows a spinner and data-loading while the text loads", async () => {
    useClipboard(() => Promise.resolve());
    let resolve: (text: string) => void = () => {};
    const wrapper = mountButton({ value: () => new Promise<string>((done) => (resolve = done)) });
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(icon(wrapper)).toBe("loader-circle");
    expect(wrapper.get("button").attributes("data-loading")).toBe("");
    resolve("loaded");
    await flushPromises();
    expect(icon(wrapper)).toBe("check");
    expect(wrapper.get("button").attributes("data-copied")).toBe("");
  });

  it("loads the text on pointerenter with `preload`, then writes it on click", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    const load = vi.fn(() => Promise.resolve("# Page"));
    const wrapper = mountButton({ value: load, preload: true });

    await wrapper.get("button").trigger("pointerenter");
    expect(load).toHaveBeenCalledOnce();
    await wrapper.get("button").trigger("focus");
    expect(load).toHaveBeenCalledOnce();
    await flushPromises();

    await wrapper.get("button").trigger("click");
    // The text is ready, so the click writes the string at once, with no loading icon.
    expect(writeText).toHaveBeenCalledWith("# Page");
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
    await flushPromises();
    expect(load).toHaveBeenCalledOnce();
    expect(wrapper.get("button").attributes("data-copied")).toBe("");

    // A click uses the loaded text once. The next one loads again.
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads on focus with `preload`, and writes the pending text through a ClipboardItem", async () => {
    const write = vi.fn((_items: ClipboardItem[]) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText: vi.fn() } });
    let resolve: (text: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((done) => (resolve = done)));
    const wrapper = mountButton({ value: load, preload: true });

    await wrapper.get("button").trigger("focus");
    expect(load).toHaveBeenCalledOnce();
    await wrapper.get("button").trigger("click");
    // The click starts the write with the text that focus started to load.
    expect(write).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    resolve("# Page");
    const [item] = write.mock.calls[0]![0];
    await expect((await item!.getType("text/plain")).text()).resolves.toBe("# Page");
  });

  it("loads again on click when the preload failed, and never preloads without `preload`", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    useClipboard(writeText);
    const load = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue("# Page");
    const wrapper = mountButton({ value: load, preload: true });
    await wrapper.get("button").trigger("pointerenter");
    await flushPromises();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledWith("# Page");

    const plain = vi.fn(() => "text");
    await mountButton({ value: plain }).get("button").trigger("pointerenter");
    expect(plain).not.toHaveBeenCalled();
  });
});
