// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";

import { CodeBlockContent, CodeBlockLine, useHighlightedCode } from "../src/index.ts";

// Shiki fails to load once, as a chunk can fail to arrive on a flaky network.
const shiki = vi.hoisted(() => ({ failures: 1 }));

vi.mock("shiki/core", async (importOriginal) => {
  if (shiki.failures > 0) {
    shiki.failures--;
    throw new Error("transient Shiki import failure");
  }
  return await importOriginal();
});

const Highlighted = defineComponent({
  props: { code: { required: true, type: String } },
  setup(props) {
    const lines = useHighlightedCode(() => props.code, "ts");
    return () => h(CodeBlockContent, () => lines.value.map((line, index) => h(CodeBlockLine, { key: index }, () => line)));
  },
});

describe("useHighlightedCode", () => {
  it("loads Shiki again for the next code block after a failed load", async () => {
    const first = mount(Highlighted, { props: { code: "const a = 1" } });
    await vi.waitFor(() => expect(shiki.failures).toBe(0));
    await flushPromises();
    expect(first.html()).not.toContain("--shiki-light");

    const second = mount(Highlighted, { props: { code: "const b = 2" } });
    await vi.waitFor(() => expect(second.html()).toContain("--shiki-light:"), { timeout: 5_000 });
    first.unmount();
    second.unmount();
  });
});
