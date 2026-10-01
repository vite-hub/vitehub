// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, Suspense } from "vue";

import { AgentMarkdown } from "../src/components/agent-markdown.ts";

const katex = vi.hoisted(() => ({ loads: 0 }));

vi.mock("katex", async (importOriginal) => {
  katex.loads++;
  return await importOriginal();
});

function render(value: string) {
  return mount(defineComponent({
    setup() { return () => h(Suspense, null, { default: () => h(AgentMarkdown, { value }) }); },
  }));
}

function renderDirect(value: string) {
  return mount(AgentMarkdown, { props: { value } });
}

describe("AgentMarkdown KaTeX loading", () => {
  it("loads KaTeX with the first formula", async () => {
    const plain = render("No formulas here.");
    await vi.waitFor(() => expect(plain.text()).toContain("No formulas here."));
    await flushPromises();
    expect(katex.loads).toBe(0);

    const math = render("Inline $x^2$ and $y^2$.");
    await vi.waitFor(() => expect(math.findAll(".katex")).toHaveLength(2));
    expect(katex.loads).toBe(1);
    plain.unmount();
    math.unmount();
  });

  it("renders math without a parent Suspense boundary", async () => {
    const wrapper = renderDirect("Inline $x^2$.");
    await vi.waitFor(() => expect(wrapper.find(".katex").exists()).toBe(true));
    wrapper.unmount();
  });
});
