// @vitest-environment happy-dom
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { AgentMessageParts } from "../src/components/agent-message-parts.ts";

const UChatTool = defineComponent({ setup: (_, { slots }) => () => h("section", slots.default?.()) });

describe("ui tool value repro", () => {
  it.each([
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), '"self": "[Circular]"'],
    ["bigint", { count: 1n }, '"count": "1n"'],
    ["throwing toJSON", { toJSON() { throw new Error("cannot serialize"); } }, "Unable to display payload: cannot serialize"],
  ])("renders %s tool values without crashing", (_name, output, expected) => {
    const wrapper = mount(AgentMessageParts, {
      global: { components: { UChatTool } },
      props: { parts: [{ state: "output-available", toolCallId: "call", type: "tool-shell", output } as never] },
    });
    expect(wrapper.text()).toContain(expected);
  });

  it("preserves the message from a cross-realm Error when serialization fails", () => {
    const output = vm.runInNewContext("({ toJSON() { throw new Error('cross realm failure'); } })");
    const wrapper = mount(AgentMessageParts, {
      global: { components: { UChatTool } },
      props: { parts: [{ state: "output-available", toolCallId: "call", type: "tool-shell", output } as never] },
    });
    expect(wrapper.text()).toContain("Unable to display payload: cross realm failure");
  });
});
