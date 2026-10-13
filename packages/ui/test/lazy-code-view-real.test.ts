// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  AgentFileDiff,
  AgentMultiFileDiff,
  AgentPatchDiff,
} from "../src/components/agent-code-view.ts";

const patch = "--- a/ready.ts\n+++ b/ready.ts\n@@ -5 +5 @@\n-false\n+true\n";
const oldFile = { contents: "first\nsecond\nthird\nfourth\nfalse\nsixth\nlast\n", name: "ready.ts" };
const newFile = { ...oldFile, contents: oldFile.contents.replace("false", "true") };

describe("lazy Pierre renderer", () => {
  it("loads the real patch renderer through the public component", async () => {
    const wrapper = mount(AgentPatchDiff, {
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
    const wrapper = mount(AgentFileDiff, {
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
    const wrapper = mount(AgentMultiFileDiff, {
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
    const wrapper = mount(AgentPatchDiff, { props: { patch, options: { loadDiffFiles } } });

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
});
