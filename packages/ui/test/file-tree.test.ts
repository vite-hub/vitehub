// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { FileTree, useFileTree } from "../src/components/file-tree.ts";

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
});
