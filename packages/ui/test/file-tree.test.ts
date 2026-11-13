// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { FileTree, type FileTreeModel, useFileTree } from "../src/components/file-tree.ts";

describe("FileTree", () => {
  it("names the tree and its search input, and keeps the names when Pierre re-renders", async () => {
    const model = useFileTree({ paths: ["src/index.ts", "README.md"], search: true });
    const wrapper = mount(FileTree, { attrs: { "aria-label": "Skill files" }, props: { model } });
    const shadowRoot = wrapper.get("file-tree-container").element.shadowRoot;
    const input = shadowRoot?.querySelector<HTMLInputElement>("[data-file-tree-search-input]");

    expect(shadowRoot?.querySelector("[role='tree']")?.getAttribute("aria-label")).toBe("Skill files");
    expect(input?.getAttribute("aria-label")).toBe("Search files");

    model.openSearch("index");
    await vi.waitFor(() => expect(input?.value).toBe("index"));
    model.closeSearch();
    await vi.waitFor(() => expect(input?.value).toBe(""));

    expect(shadowRoot?.querySelector("[data-file-tree-search-input]")).toBe(input);
    expect(input?.getAttribute("aria-label")).toBe("Search files");
    wrapper.unmount();
    model.cleanUp();
  });

  it("keeps a custom search label through Pierre updates and model replacement", async () => {
    const model = useFileTree({ paths: ["src/index.ts"], search: true });
    const replacement = useFileTree({ paths: ["README.md"], search: true });
    const wrapper = mount(FileTree, { props: { model, searchLabel: "Buscar archivos" } });
    const getInput = () => wrapper.get("file-tree-container").element.shadowRoot
      ?.querySelector<HTMLInputElement>("[data-file-tree-search-input]");

    try {
      const input = getInput();
      expect(input?.getAttribute("aria-label")).toBe("Buscar archivos");

      model.openSearch("index");
      await vi.waitFor(() => expect(input?.value).toBe("index"));
      model.closeSearch();
      await vi.waitFor(() => expect(input?.value).toBe(""));
      expect(getInput()).toBe(input);
      expect(input?.getAttribute("aria-label")).toBe("Buscar archivos");

      await wrapper.setProps({ searchLabel: "Rechercher des fichiers" });
      expect(getInput()?.getAttribute("aria-label")).toBe("Rechercher des fichiers");

      await wrapper.setProps({ model: replacement });
      const replacementInput = getInput();
      expect(replacementInput).not.toBe(input);
      expect(replacementInput?.getAttribute("aria-label")).toBe("Rechercher des fichiers");
      replacement.openSearch("readme");
      await vi.waitFor(() => expect(replacementInput?.value).toBe("readme"));
      replacement.closeSearch();
      await vi.waitFor(() => expect(replacementInput?.value).toBe(""));
      expect(getInput()?.getAttribute("aria-label")).toBe("Rechercher des fichiers");

      await wrapper.setProps({ searchLabel: undefined });
      expect(getInput()?.getAttribute("aria-label")).toBe("Search files");
    } finally {
      wrapper.unmount();
      model.cleanUp();
      replacement.cleanUp();
    }
  });

  it("keeps a custom search label when options replace the owned model", async () => {
    const wrapper = mount(FileTree, {
      props: { paths: ["src/index.ts"], options: { search: true }, searchLabel: "Search workspace files" },
    });
    const getInput = () => wrapper.get("file-tree-container").element.shadowRoot
      ?.querySelector<HTMLInputElement>("[data-file-tree-search-input]");

    try {
      const input = getInput();
      expect(input?.getAttribute("aria-label")).toBe("Search workspace files");
      await wrapper.setProps({ options: { search: true, initialExpansion: "open" } });
      expect(getInput()).not.toBe(input);
      expect(getInput()?.getAttribute("aria-label")).toBe("Search workspace files");
    } finally {
      wrapper.unmount();
    }
  });

  it("selects the file of selectedPath, opens its folders, and reports the viewer's selection", async () => {
    const wrapper = mount(FileTree, {
      props: {
        options: { initialExpansion: "closed" },
        paths: ["src/chat/Message.vue", "src/index.ts", "README.md"],
        selectedPath: "src/chat/Message.vue",
      },
    });
    const model: FileTreeModel = wrapper.vm.$.exposed?.getModel();
    const expanded = (path: string) => {
      const folder = model.getItem(path);
      return folder && "isExpanded" in folder ? folder.isExpanded() : undefined;
    };

    try {
      expect(model.getSelectedPaths()).toEqual(["src/chat/Message.vue"]);
      expect([expanded("src"), expanded("src/chat")]).toEqual([true, true]);

      await wrapper.setProps({ selectedPath: "README.md" });
      expect(model.getSelectedPaths()).toEqual(["README.md"]);
      expect(wrapper.emitted("update:selectedPath")).toBeUndefined();

      // The viewer selects another file. A folder is not a file, so it reports nothing.
      model.getItem("README.md")?.deselect();
      model.getItem("src")?.select();
      model.getItem("src/index.ts")?.select();
      await vi.waitFor(() => expect(wrapper.emitted("update:selectedPath")).toEqual([["src/index.ts"]]));
      await wrapper.setProps({ selectedPath: "src/index.ts" });
      expect(model.getSelectedPaths()).toEqual(["src/", "src/index.ts"]);

      await wrapper.setProps({ selectedPath: "deleted.ts" });
      expect(model.getSelectedPaths()).toEqual([]);

      // New paths can bring the selected file.
      await wrapper.setProps({ paths: ["deleted.ts", "README.md"] });
      expect(model.getSelectedPaths()).toEqual(["deleted.ts"]);
    } finally {
      wrapper.unmount();
    }
  });
});
