// @vitest-environment happy-dom
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentTrace } from "../src/components/agent-trace.ts";

const UCollapsible = defineComponent({ setup: (_, { slots }) => () => h("div", [slots.default?.(), slots.content?.()]) });
const UBadge = defineComponent({ setup: (_, { slots }) => () => h("span", slots.default?.()) });

describe("ui trace attributes repro", () => {
  it.each([
    ["throwing ownKeys", new Proxy({}, { ownKeys() { throw new Error("cannot inspect"); } }), "Unable to display payload: cannot inspect"],
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), '"self": "[Circular]"'],
    ["bigint", { count: 1n }, '"count": "1n"'],
    ["throwing toJSON", { toJSON() { throw new Error("cannot serialize"); } }, "Unable to display payload: cannot serialize"],
  ])("renders %s trace attributes without crashing", (_name, attributes, expected) => {
    const wrapper = mount(defineComponent({
      setup: () => () => h(AgentTrace, {
        run: { events: [], id: "run", startTime: "2026-10-11T00:00:00Z", status: "completed", steps: [{ attributes, events: [], id: "step", name: "Step", startTime: "2026-10-11T00:00:00Z", status: "completed", type: "run" }] },
      }),
    }), {
      global: { components: { UBadge, UCollapsible } },
    });
    expect(wrapper.text()).toContain(expected);
  });
});
