// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  FileDiff,
  FileView,
  MultiFileDiff,
  PatchDiff,
} from "../src/components/code-view.ts";

const patch = "--- a/ready.ts\n+++ b/ready.ts\n@@ -5 +5 @@\n-false\n+true\n";
const oldFile = { contents: "first\nsecond\nthird\nfourth\nfalse\nsixth\nlast\n", name: "ready.ts" };
const newFile = { ...oldFile, contents: oldFile.contents.replace("false", "true") };

describe("lazy Pierre renderer", () => {
  it("loads the real patch renderer through the public component", async () => {
    const wrapper = mount(PatchDiff, {
      props: {
        patch: "--- a/ready.ts\n+++ b/ready.ts\n@@ -1 +1 @@\n-false\n+true\n",
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.get("diffs-container").element.shadowRoot?.textContent).toContain("true");
    });
    wrapper.unmount();
  });

  it("renders partial patch metadata without pointer-only expansion controls", async () => {
    const { getSingularPatch } = await import("@pierre/diffs");
    const wrapper = mount(FileDiff, {
      props: {
        fileDiff: getSingularPatch(patch),
        options: { enableLineSelection: true, expandUnchanged: true },
        selectedLines: { start: 5, end: 5, side: "additions" },
      },
    });

    await vi.waitFor(() => {
      const shadowRoot = wrapper.get("diffs-container").element.shadowRoot;
      expect(shadowRoot?.textContent).toContain("true");
      expect(shadowRoot?.querySelector('[data-separator="metadata"]')?.textContent).toContain(
        "@@ -5 +5 @@",
      );
      expect(shadowRoot?.querySelector("[data-expand-button]")).toBeNull();
      expect(shadowRoot?.querySelector("[data-selected-line]")).not.toBeNull();
    });
    wrapper.unmount();
  });

  it("expands unchanged lines in complete file comparisons", async () => {
    const wrapper = mount(MultiFileDiff, {
      props: { oldFile, newFile, options: { expandUnchanged: false, parseDiffOptions: { context: 0 } } },
    });

    await vi.waitFor(() => {
      const shadowRoot = wrapper.get("diffs-container").element.shadowRoot;
      expect(shadowRoot?.textContent).toContain("true");
      expect(shadowRoot?.textContent).toContain("first");
      expect(shadowRoot?.textContent).toContain("last");
      expect(shadowRoot?.querySelector("[data-expand-button]")).toBeNull();
    });
    wrapper.unmount();
  });

  it("loads full files when a partial patch consumer provides a loader", async () => {
    const loadDiffFiles = vi.fn(async () => ({ oldFile, newFile }));
    const wrapper = mount(PatchDiff, { props: { patch, options: { loadDiffFiles } } });

    await vi.waitFor(() => {
      const shadowRoot = wrapper.get("diffs-container").element.shadowRoot;
      expect(shadowRoot?.textContent).toContain("true");
      expect(shadowRoot?.textContent).toContain("first");
      expect(shadowRoot?.textContent).toContain("last");
      expect(shadowRoot?.querySelector("[data-expand-button]")).toBeNull();
    });
    expect(loadDiffFiles).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it("scrolls to the selected lines once for each new selection", async () => {
    const scrolled: (string | undefined)[] = [];
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset.line);
    });
    const file = { contents: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), name: "notes.txt" };
    const wrapper = mount(FileView, {
      props: { file, scrollToSelectedLines: true, selectedLines: { start: 30, end: 31 } },
    });

    try {
      await vi.waitFor(() => expect(scrolled).toEqual(["30"]));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });

      // The same range and file in new objects is not a new selection.
      await wrapper.setProps({ file: { ...file }, selectedLines: { start: 30, end: 31 } });
      await wrapper.setProps({ selectedLines: { start: 5, end: 5 } });
      await vi.waitFor(() => expect(scrolled).toEqual(["30", "5"]));

      await wrapper.setProps({ scrollToSelectedLines: false, selectedLines: { start: 12, end: 12 } });
      await vi.waitFor(() => {
        const row = wrapper.get("diffs-container").element.shadowRoot?.querySelector<HTMLElement>("[data-line][data-selected-line]");
        expect(row?.dataset.line).toBe("12");
      });
      expect(scrolled).toEqual(["30", "5"]);
    } finally {
      wrapper.unmount();
      scrollIntoView.mockRestore();
    }
  });

  it("scrolls only the nearest scroller of the view", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    document.body.append(scroller);
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, this === scroller ? 100 : 500, 300, this === scroller ? 200 : 20);
    });
    const wrapper = mount(FileView, {
      attachTo: scroller,
      props: { file: { contents: "one\ntwo\nthree", name: "notes.txt" }, scrollToSelectedLines: true, selectedLines: { start: 2, end: 2 } },
    });

    try {
      // The row is 400px below the scroller's top. Its center goes to the scroller's center.
      await vi.waitFor(() => expect(scroller.scrollTop).toBe(310));
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
      scroller.remove();
      rects.mockRestore();
      scrollIntoView.mockRestore();
    }
  });

  it("scrolls to selected lines on the side of a diff that has them", async () => {
    const scrolled: (string | undefined)[] = [];
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset.line);
    });
    const wrapper = mount(MultiFileDiff, {
      props: { newFile, oldFile, scrollToSelectedLines: true, selectedLines: { end: 5, side: "additions", start: 5 } },
    });

    try {
      await vi.waitFor(() => expect(scrolled).toEqual(["5"]));
    } finally {
      wrapper.unmount();
      scrollIntoView.mockRestore();
    }
  });
});
