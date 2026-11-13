// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { renderToString } from "@vue/server-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import * as playground from "../src/playground/share.ts";
import { decodePlaygroundLink, encodePlaygroundLink, playgroundLinkLimit, readPlaygroundHash } from "../src/playground.ts";
import { PlaygroundRender, type PlaygroundFiles, type PlaygroundPaneSlotProps, type PlaygroundResult } from "../src/index.ts";

const presets = [
  { files: { "config.json": "{}\n", "content.md": "# Hello\n" }, group: "Basics", id: "hello", label: "Hello" },
  { files: { "config.json": "{}\n", "content.md": "*Bye*\n" }, group: "Basics", id: "bye", label: "Bye" },
];
const panes = [
  { file: "content.md", label: "Markdown", language: "markdown" },
  { file: "config.json", label: "Config", language: "json" },
];

// A Markdown renderer that is enough for the tests: a heading and a paragraph, and an issue for an empty file.
async function markdown(files: PlaygroundFiles): Promise<PlaygroundResult> {
  const source = files["content.md"] ?? "";
  const html = source.split("\n").filter(Boolean).map(line => line.startsWith("# ") ? `<h1>${line.slice(2)}</h1>` : `<p>${line}</p>`).join("");
  return { html, issues: source.trim() ? [] : [{ line: 1, message: "The file is empty." }] };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve };
}

function mountPlayground(render = vi.fn(markdown), props: Record<string, unknown> = {}) {
  const wrapper = mount(PlaygroundRender, { attachTo: document.body, props: { panes, presets, render, ...props } });
  return { render, wrapper };
}

const srcdoc = (wrapper: ReturnType<typeof mountPlayground>["wrapper"]) => wrapper.get("iframe").attributes("srcdoc") ?? "";

describe("PlaygroundRender", () => {
  // happy-dom fires hashchange after replaceState, which browsers do not. Let it go by before the next playground mounts.
  beforeEach(async () => {
    history.replaceState(null, "", "/play");
    await wait(10);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the first preset's files into the preview", async () => {
    const { render, wrapper } = mountPlayground();
    await flushPromises();
    await vi.waitFor(() => expect(srcdoc(wrapper)).toContain("<h1>Hello</h1>"));
    expect(render).toHaveBeenCalledWith(presets[0]!.files);
    expect(wrapper.get("textarea").element.value).toBe("# Hello\n");
    expect(wrapper.get('[data-preset="hello"]').attributes("aria-current")).toBe("true");
    // The first render keeps the URL as it was.
    expect(location.hash).toBe("");
    wrapper.unmount();
  });

  it("waits for typing to stop, writes the link to the hash, and shows issues", async () => {
    const { render, wrapper } = mountPlayground();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const textarea = wrapper.get("textarea");
    await textarea.setValue("# Hel");
    await textarea.setValue("");
    await wait(100);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(render).toHaveBeenLastCalledWith({ "config.json": "{}\n", "content.md": "" });
    await vi.waitFor(() => expect(wrapper.get(".vh-pg-issues").text()).toBe("Line 1The file is empty."));
    expect(wrapper.get(".vh-pg-issues").attributes("hidden")).toBeUndefined();

    await vi.waitFor(() => expect(readPlaygroundHash(location.hash)).toBeDefined());
    const code = readPlaygroundHash(location.hash);
    expect(code).toBeDefined();
    expect(await decodePlaygroundLink(code!, presets)).toEqual({ files: { "config.json": "{}\n", "content.md": "" }, template: "hello" });
    expect(wrapper.find('[data-action="reset"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("drops a render that ends after a newer one", async () => {
    const pending: Array<(result: PlaygroundResult) => void> = [];
    const render = vi.fn((_files: PlaygroundFiles) => new Promise<PlaygroundResult>((resolve) => { pending.push(resolve); }));
    const { wrapper } = mountPlayground(render);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await wrapper.get('[data-preset="bye"]').trigger("click");
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    pending[1]!({ html: "<p>new</p>" });
    await flushPromises();
    pending[0]!({ html: "<p>old</p>" });
    await flushPromises();
    expect(srcdoc(wrapper)).toContain("<p>new</p>");
    expect(srcdoc(wrapper)).not.toContain("<p>old</p>");
    wrapper.unmount();
  });

  it.each(["edit", "preset", "hash"])("invalidates an old render immediately on %s", async (change) => {
    const pending = deferred<PlaygroundResult>();
    const render = vi.fn(markdown).mockReturnValueOnce(pending.promise);
    const { wrapper } = mountPlayground(render);
    try {
      await flushPromises();
      expect(render).toHaveBeenCalledTimes(1);
      if (change === "edit") await wrapper.get("textarea").setValue("# Edited\n");
      else if (change === "preset") {
        vi.spyOn(playground, "encodePlaygroundLink").mockReturnValue(new Promise(() => {}));
        await wrapper.get('[data-preset="bye"]').trigger("click");
      }
      else {
        vi.spyOn(playground, "decodePlaygroundLink").mockReturnValue(new Promise(() => {}));
        location.hash = "#code=pending";
        await wait(10);
      }
      pending.resolve({ html: "<p>old</p>", issues: [{ message: "Old issue" }] });
      await flushPromises();
      expect(srcdoc(wrapper)).not.toContain("<p>old</p>");
      expect(wrapper.get(".vh-pg-issues").text()).not.toContain("Old issue");
    }
    finally { wrapper.unmount(); }
  });

  it("drops an old render error during the edit debounce", async () => {
    const pending = deferred<PlaygroundResult>();
    const { wrapper } = mountPlayground(vi.fn(markdown).mockReturnValueOnce(pending.promise));
    try {
      await flushPromises();
      await wrapper.get("textarea").setValue("# Edited\n");
      pending.reject(new Error("Old error"));
      await flushPromises();
      expect(wrapper.get(".vh-pg-issues").text()).not.toContain("Old error");
    }
    finally { wrapper.unmount(); }
  });

  it.each(["edit", "hash"])("invalidates an old encoder immediately on %s", async (change) => {
    const pending = deferred<string>();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { wrapper } = mountPlayground();
    try {
      await flushPromises();
      vi.spyOn(playground, "encodePlaygroundLink").mockReturnValueOnce(pending.promise);
      await wrapper.get('[data-action="copy-link"]').trigger("click");
      if (change === "edit") await wrapper.get("textarea").setValue("# Edited\n");
      else {
        vi.spyOn(playground, "decodePlaygroundLink").mockReturnValue(new Promise(() => {}));
        location.hash = "#code=navigated";
        await wait(10);
      }
      const navigated = location.hash;
      pending.resolve("old-code");
      await flushPromises();
      expect(location.hash).toBe(navigated);
      expect(writeText).not.toHaveBeenCalled();
    }
    finally { wrapper.unmount(); }
  });

  it("keeps an edit made while a shared link is decoding", async () => {
    const pending = deferred<Awaited<ReturnType<typeof decodePlaygroundLink>>>();
    const { wrapper } = mountPlayground();
    try {
      await flushPromises();
      vi.spyOn(playground, "decodePlaygroundLink").mockReturnValue(pending.promise);
      location.hash = "#code=pending";
      await wait(10);
      await wrapper.get("textarea").setValue("# Edited\n");
      pending.resolve({ files: presets[1]!.files, template: "bye" });
      await flushPromises();
      expect(wrapper.get("textarea").element.value).toBe("# Edited\n");
    }
    finally { wrapper.unmount(); }
  });

  it.each(["valid", "invalid"])("loads a previously written hash after another link (%s)", async (link) => {
    const { wrapper } = mountPlayground();
    try {
      await flushPromises();
      await wrapper.get('[data-preset="bye"]').trigger("click");
      await vi.waitFor(() => expect(readPlaygroundHash(location.hash)).toBeDefined());
      const written = location.hash;
      await wait(10);
      const code = link === "valid"
        ? await encodePlaygroundLink({ files: { "content.md": "# Shared\n" }, template: "hello" }, presets[0]!.files)
        : "not-a-code";
      location.hash = `#code=${code}`;
      await vi.waitFor(() => expect(wrapper.get("textarea").element.value).toBe(link === "valid" ? "# Shared\n" : "# Hello\n"));
      location.hash = written;
      await vi.waitFor(() => expect(wrapper.get("textarea").element.value).toBe("*Bye*\n"));
      expect(srcdoc(wrapper)).toContain("<p>*Bye*</p>");
    }
    finally { wrapper.unmount(); }
  });

  it("switches presets and opens shared links", async () => {
    const { render, wrapper } = mountPlayground();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await wrapper.get('[data-preset="bye"]').trigger("click");
    await vi.waitFor(() => expect(srcdoc(wrapper)).toContain("<p>*Bye*</p>"));
    expect(wrapper.get('[data-preset="bye"]').attributes("aria-current")).toBe("true");
    await vi.waitFor(() => expect(readPlaygroundHash(location.hash)).toBeDefined());
    expect(await decodePlaygroundLink(readPlaygroundHash(location.hash)!, presets)).toEqual({ files: presets[1]!.files, template: "bye" });

    const shared = await encodePlaygroundLink({ files: { ...presets[0]!.files, "content.md": "# Shared\n" }, template: "hello" }, presets[0]!.files);
    location.hash = `code=${shared}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(srcdoc(wrapper)).toContain("<h1>Shared</h1>"));
    expect(wrapper.get("textarea").element.value).toBe("# Shared\n");
    expect(wrapper.find('[data-preset][aria-current="true"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("tells the reader when a link cannot be read, and opens the default preset", async () => {
    history.replaceState(null, "", "/play#code=not-a-code");
    await wait(10);
    const { wrapper } = mountPlayground(vi.fn(markdown), { preset: "bye" });
    await vi.waitFor(() => expect(srcdoc(wrapper)).toContain("<p>*Bye*</p>"));
    expect(wrapper.get('[role="status"]').text()).toContain("cut off or changed");
    wrapper.unmount();
  });

  it("resets to the preset after the reader confirms", async () => {
    const { render, wrapper } = mountPlayground();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await wrapper.get("textarea").setValue("# Edited\n");
    await vi.waitFor(() => expect(wrapper.find('[data-action="reset"]').exists()).toBe(true));
    const dialog = wrapper.get("dialog").element as HTMLDialogElement;
    dialog.returnValue = "reset";
    dialog.dispatchEvent(new Event("close"));
    await vi.waitFor(() => expect(wrapper.get("textarea").element.value).toBe("# Hello\n"));
    expect(wrapper.find('[data-action="reset"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("copies the link, and refuses a link that is too long", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { render, wrapper } = mountPlayground();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await wrapper.get('[data-action="copy-link"]').trigger("click");
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(location.href));
    expect(wrapper.get('[data-action="copy-link"]').text()).toBe("Copied");

    // Random text does not compress, so the link grows past the limit.
    const noise = Array.from({ length: playgroundLinkLimit }, () => Math.random().toString(36).slice(2, 4)).join("");
    await wrapper.get("textarea").setValue(noise);
    await wrapper.get('[data-action="copy-link"]').trigger("click");
    await vi.waitFor(() => expect(wrapper.get('[role="status"]').text()).toContain("too big for a link"));
    expect(writeText).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("shows a slot in place of the editor for a pane with a slot", async () => {
    const wrapper = mount(PlaygroundRender, {
      props: { panes: [...panes, { file: "theme.json", label: "Theme", slot: "theme" }], presets, render: markdown },
      slots: {
        theme: ({ setFile, value }: PlaygroundPaneSlotProps) =>
          h("button", { class: "dark-theme", onClick: () => setFile("theme.json", "{\"scheme\":\"dark\"}") }, `Theme: ${value || "none"}`),
      },
    });
    await wrapper.findAll(".vh-pg-tab")[2]!.trigger("click");
    expect(wrapper.get('[data-file="theme.json"]').attributes("hidden")).toBeUndefined();
    expect(wrapper.get('[data-file="content.md"]').attributes("hidden")).toBeDefined();
    await wrapper.get(".dark-theme").trigger("click");
    expect(wrapper.get(".dark-theme").text()).toBe("Theme: {\"scheme\":\"dark\"}");
    wrapper.unmount();
  });

  it("renders its markup on the server", async () => {
    const app = createSSRApp({ render: () => h(PlaygroundRender, { panes, presets, render: markdown }) });
    const html = await renderToString(app);
    expect(html).toContain("# Hello");
    expect(html).toContain("Copy link");
    expect(html).toContain('aria-current="true"');
  });
});
