// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentToolList } from "../src/components/agent-tool-list.ts";
import type { AgentInspectionValue } from "../src/types.ts";

const cyclic: Record<string, AgentInspectionValue> = { type: "object" };
cyclic.self = cyclic;
const shared = { type: "string", description: "A repeated field" };
const nullPrototype: Record<string, AgentInspectionValue> = Object.assign(Object.create(null), {
  type: "object", properties: { name: shared }, required: ["name"],
});
const throwingGetter = Object.defineProperty({ type: "object" }, "properties", {
  enumerable: true,
  get() { throw new Error("cannot read schema"); },
});

describe("AgentToolList schema display", () => {
  it.each([
    { name: "cyclic", schema: cyclic, expected: '"self": "[Circular]"' },
    { name: "bigint", schema: { type: "object", count: 1n }, expected: '"count": "1n"' },
    { name: "throwing toJSON", schema: { toJSON() { throw new Error("cannot serialize"); } }, expected: "[Unable to display payload: cannot serialize]" },
    { name: "throwing getter", schema: throwingGetter, expected: "[Unable to display payload: cannot read schema]" },
    { name: "null prototype", schema: nullPrototype, expected: '"description": "A repeated field"' },
  ])("preserves both schema displays for $name", ({ schema, expected }) => {
    // Runtime callers can supply values outside the recorded JSON contract.
    const value = schema as AgentInspectionValue;
    const wrapper = mount({ render: () => h(AgentToolList, { tools: [{ name: "tool", inputSchema: value, outputSchema: value }] }) });
    expect(wrapper.findAll("pre").map(pre => pre.text())).toEqual([expect.stringContaining(expected), expect.stringContaining(expected)]);
    expect(wrapper.text()).toContain("Input schema");
    expect(wrapper.text()).toContain("Output schema");
    wrapper.unmount();
  });

  it("preserves required fields and repeated references without marking them as cycles", () => {
    const schema = { type: "object", properties: { first: shared, second: shared }, required: ["first"] };
    const wrapper = mount(AgentToolList, { props: { tools: [{ name: "tool", inputSchema: schema }] } });
    expect(wrapper.findAll("tbody tr").map(row => row.text())).toEqual(["firstRequiredstringA repeated field", "secondstringA repeated field"]);
    expect(wrapper.get("pre").text()).toBe(JSON.stringify(schema, null, 2));
    wrapper.unmount();
  });

  it("renders cyclic schemas during server rendering", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(AgentToolList, { tools: [{ name: "tool", inputSchema: cyclic }] }) }));
    expect(html).toContain("[Circular]");
    expect(html).toContain("Input schema");
  });
});
