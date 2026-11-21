// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createViteHubUI } from "../src/config.ts";
import { uiSdkComponents } from "../src/ui-sdk/components.ts";
import { createCodeEditor } from "../src/workspace/codemirror.ts";
import { WorkspaceEditor } from "../src/workspace/workspace-editor.ts";
import { WorkspaceEditorHead } from "../src/workspace/workspace-editor-head.ts";
import { WorkspaceFileTree } from "../src/workspace/workspace-file-tree.ts";
import { WorkspaceStatus, workspaceLanguage } from "../src/workspace/workspace-status.ts";

const global = { plugins: [createViteHubUI({ components: uiSdkComponents })] };

function pressAltZ(target: Element, key = "z", code = "KeyZ") {
  const event = new KeyboardEvent("keydown", { altKey: true, bubbles: true, cancelable: true, code, key, keyCode: 90 });
  target.dispatchEvent(event);
  return event;
}

describe("line wrapping", () => {
  it("wraps through a compartment and asks for the other state on Alt+Z", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onToggleWrap = vi.fn();
    const editor = createCodeEditor({ doc: "const a = 1", onChange: () => {}, onCursor: () => {}, onToggleWrap, parent, path: "a.ts", readonly: false, wrap: true });
    try {
      const content = parent.querySelector(".cm-content")!;
      expect(content.classList.contains("cm-lineWrapping")).toBe(true);
      editor.setWrap(false);
      expect(content.classList.contains("cm-lineWrapping")).toBe(false);

      pressAltZ(content);
      expect(onToggleWrap).toHaveBeenCalledTimes(1);
      // The editor waits for `setWrap`, so a bound value stays the source of truth.
      expect(content.classList.contains("cm-lineWrapping")).toBe(false);

      // Option+Z on a US Mac layout types `Ω`. The physical Z key still toggles, and the character is not typed.
      expect(pressAltZ(content, "Ω").defaultPrevented).toBe(true);
      expect(onToggleWrap).toHaveBeenCalledTimes(2);
      // A layout that puts another letter on the Z key, such as AZERTY, goes by the letter.
      pressAltZ(content, "w");
      pressAltZ(content, "z", "KeyW");
      expect(onToggleWrap).toHaveBeenCalledTimes(3);
    }
    finally {
      editor.destroy();
      parent.remove();
    }
  });

  it("toggles WorkspaceEditor with Alt+Z and follows v-model:wrap", async () => {
    const wrapper = mount(WorkspaceEditor, {
      attachTo: document.body,
      props: { modelValue: "const a = 1", path: "a.ts", wrap: false, "onUpdate:wrap": (wrap: boolean) => wrapper.setProps({ wrap }) },
    });
    await vi.waitFor(() => expect(wrapper.find(".cm-content").exists()).toBe(true));
    const content = () => wrapper.get(".cm-content").element;
    expect(content().classList.contains("cm-lineWrapping")).toBe(false);

    pressAltZ(content());
    await flushPromises();
    expect(wrapper.emitted("update:wrap")).toEqual([[true]]);
    expect(wrapper.attributes("data-wrap")).toBe("");
    expect(content().classList.contains("cm-lineWrapping")).toBe(true);

    await wrapper.setProps({ wrap: false });
    expect(wrapper.attributes("data-wrap")).toBeUndefined();
    expect(content().classList.contains("cm-lineWrapping")).toBe(false);
    wrapper.unmount();
  });

  it("toggles from the button of WorkspaceEditorHead", async () => {
    const wrapper = mount(WorkspaceEditorHead, { global, props: { path: "a.ts", wrap: false } });
    const button = wrapper.get(".vh-ws-wrap-button");
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.attributes("aria-keyshortcuts")).toBe("Alt+Z");

    await button.trigger("click");
    expect(wrapper.emitted("update:wrap")).toEqual([[true]]);
    await wrapper.setProps({ wrap: true });
    expect(wrapper.get(".vh-ws-wrap-button").attributes("aria-pressed")).toBe("true");
    await wrapper.get(".vh-ws-wrap-button").trigger("click");
    expect(wrapper.emitted("update:wrap")).toEqual([[true], [false]]);
  });
});

describe("WorkspaceEditorHead", () => {
  it("shows the folders, then the icon and the name of the file", () => {
    const wrapper = mount(WorkspaceEditorHead, { global, props: { path: "src/components/Greeting.vue" } });
    const breadcrumb = wrapper.get(".vh-ws-breadcrumb");
    expect(breadcrumb.attributes("title")).toBe("src/components/Greeting.vue");
    expect(breadcrumb.findAll(":scope > span").map(folder => folder.text())).toEqual(["src", "components"]);
    expect(breadcrumb.findAll(".vh-ws-breadcrumb-separator")).toHaveLength(2);
    expect(breadcrumb.get(".vh-ws-file-icon").attributes("data-file-type")).toBe("vue");
    expect(breadcrumb.get("b").text()).toBe("Greeting.vue");
  });

  it("shows a file at the root without folders", () => {
    const wrapper = mount(WorkspaceEditorHead, { global, props: { path: "name-tagger.model.ts" } });
    expect(wrapper.findAll(".vh-ws-breadcrumb > span")).toHaveLength(0);
    expect(wrapper.get(".vh-ws-breadcrumb .vh-ws-file-icon").attributes("data-file-type")).toBe("ts");
    expect(wrapper.get(".vh-ws-breadcrumb b").text()).toBe("name-tagger.model.ts");
  });

  it("draws the muted dot for an extension that is a name of Object.prototype", () => {
    const wrapper = mount(WorkspaceEditorHead, { global, props: { path: "notes.constructor" } });
    expect(wrapper.get(".vh-ws-breadcrumb .vh-ws-file-icon").html()).toContain("·");
    expect(wrapper.get(".vh-ws-breadcrumb b").text()).toBe("notes.constructor");
  });
});

describe("WorkspaceFileTree", () => {
  const paths = ["data/dev.jsonl", "data/train.jsonl", "name-tagger.model.ts"];
  const editedRows = (wrapper: ReturnType<typeof mount>) => [...wrapper.get("file-tree-container").element.shadowRoot!
    .querySelectorAll<HTMLElement>("[data-item-git-status='modified']")].map(row => row.dataset.itemPath);

  it("draws a dot on each edited file, from a list or a set", async () => {
    const wrapper = mount(WorkspaceFileTree, { attachTo: document.body, props: { edited: ["data/train.jsonl"], paths } });
    await vi.waitFor(() => expect(editedRows(wrapper)).toEqual(["data/train.jsonl"]));

    await wrapper.setProps({ edited: new Set(["name-tagger.model.ts", "data/dev.jsonl"]) });
    await vi.waitFor(() => expect(editedRows(wrapper).sort()).toEqual(["data/dev.jsonl", "name-tagger.model.ts"]));

    await wrapper.setProps({ edited: [] });
    await vi.waitFor(() => expect(editedRows(wrapper)).toEqual([]));
    wrapper.unmount();
  });

  it("gives each file type its icon", async () => {
    const wrapper = mount(WorkspaceFileTree, { attachTo: document.body, props: { paths: ["a.ts", "b.vue", "c.json", "d.bin"] } });
    const root = wrapper.get("file-tree-container").element.shadowRoot!;
    const icon = (path: string) => root.querySelector(`[data-item-path='${path}'] [data-item-section='icon'] use`)?.getAttribute("href");
    await vi.waitFor(() => expect(icon("a.ts")).toBe("#vh-ws-file-ts"));
    expect(icon("b.vue")).toBe("#vh-ws-file-vue");
    expect(icon("c.json")).toBe("#vh-ws-file-json");
    expect(icon("d.bin")).toBe("#vh-ws-file-other");
    wrapper.unmount();
  });
});

describe("WorkspaceStatus", () => {
  it("shows the cursor, the language and the indentation", async () => {
    const wrapper = mount(WorkspaceStatus, { props: { cursor: { column: 7, line: 12 }, path: "name-tagger.model.ts" } });
    const items = () => wrapper.findAll(".vh-ws-status-items > span").map(item => item.text());
    expect(items()).toEqual(["Ln 12, Col 7Line 12, column 7", "TypeScript", "Spaces: 2"]);
    // The screen reader text is the long form, and the short form is hidden from it.
    expect(wrapper.get(".vh-ws-status-cursor [aria-hidden=true]").text()).toBe("Ln 12, Col 7");
    expect(wrapper.get(".vh-ws-status-cursor .vh-ws-sr-only").text()).toBe("Line 12, column 7");
    expect(wrapper.text()).not.toContain("Wrap");

    await wrapper.setProps({ indent: "tab", language: "Vue SFC" });
    expect(items()).toEqual(["Ln 12, Col 7Line 12, column 7", "Vue SFC", "Tabs"]);
  });

  it("follows the cursor of WorkspaceEditor", async () => {
    const wrapper = mount(WorkspaceEditor, { attachTo: document.body, props: { modelValue: "one\ntwo", path: "a.ts" } });
    await vi.waitFor(() => expect(wrapper.find(".cm-content").exists()).toBe(true));
    await wrapper.setProps({ modelValue: "first\nsecond line", path: "b.ts" });
    expect(wrapper.emitted("cursor")?.at(-1)).toEqual([{ column: 1, line: 1 }]);
    wrapper.unmount();
  });

  it("names the language from the extension", () => {
    expect(workspaceLanguage("src/pages/index.astro")).toBe("Astro");
    expect(workspaceLanguage("Greeting.vue")).toBe("Vue");
    expect(workspaceLanguage("data/train.jsonl")).toBe("JSON Lines");
    expect(workspaceLanguage("App.TSX")).toBe("TypeScript JSX");
    expect(workspaceLanguage("Dockerfile")).toBe("Plain Text");
    expect(workspaceLanguage(".env")).toBe("Plain Text");
    // Names of Object.prototype are not languages.
    expect(workspaceLanguage("notes.constructor")).toBe("Plain Text");
    expect(workspaceLanguage("a.toString")).toBe("Plain Text");
  });
});
