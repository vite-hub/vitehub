// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, Suspense } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { AgentMarkdown } from "../src/components/agent-markdown.ts";

async function render(value: string) {
  const wrapper = mount(defineComponent({
    props: { value: String, streaming: Boolean },
    setup(props) { return () => h(Suspense, null, { default: () => h(AgentMarkdown, props) }); },
  }), { props: { value } });
  await vi.waitFor(() => expect(wrapper.text()).not.toBe(""));
  return wrapper;
}

describe("AgentMarkdown math", () => {
  it("renders dollar and backslash inline/display formulas", async () => {
    const wrapper = await render(String.raw`Use $x^2$ and \(\sigma_w\).

$$
y = \sqrt{x}
$$

\[
SS = z\sqrt{L\sigma_w^2 + \mu_w^2\sigma_L^2} + A
\]`);
    expect(wrapper.findAll(".katex")).toHaveLength(4);
    expect(wrapper.findAll(".katex-display")).toHaveLength(2);
    expect(wrapper.findAll("math")).toHaveLength(4);
  });

  it("preserves code examples and ordinary currency", async () => {
    const wrapper = await render("Costs $10 and $20. `\\(x\\)` and `$x$`.\n\n```text\n\\[x\\]\n```\n");
    expect(wrapper.find(".katex").exists()).toBe(false);
    expect(wrapper.text()).toContain("Costs $10 and $20.");
    expect(wrapper.text()).toContain("\\(x\\)");
  });

  it("keeps incomplete streamed and invalid formulas readable", async () => {
    const wrapper = await render(String.raw`\(\notARealMathCommand{x}\)`);
    expect(wrapper.get(".vh-math-fallback").text()).toContain("notARealMathCommand");
    await wrapper.setProps({ value: "\\[x", streaming: true });
    await flushPromises();
    expect(wrapper.text()).toContain("x");
    await wrapper.setProps({ value: "\\[x^2\\]", streaming: false });
    await vi.waitFor(() => expect(wrapper.find(".katex-display").exists()).toBe(true));
  });

  it("does not permit trusted HTML or unsafe math links", async () => {
    const wrapper = await render(String.raw`\(\href{javascript:alert(1)}{click}\)`);
    expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
    expect(wrapper.find("script").exists()).toBe(false);
  });
});
