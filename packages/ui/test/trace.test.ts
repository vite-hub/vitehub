// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import { AgentTrace } from "../src/components/agent-trace.ts";

const CollapsibleStub = defineComponent({
  setup(_props, { slots }) {
    return () => h("div", [slots.default?.(), slots.content?.()]);
  },
});

const BadgeStub = defineComponent({
  setup(_props, { slots }) {
    return () => h("span", slots.default?.());
  },
});

describe("AgentTrace", () => {
  it("names each trace step and keeps the disclosure trigger native", () => {
    const wrapper = mount(AgentTrace, {
      global: { components: { UBadge: BadgeStub, UCollapsible: CollapsibleStub } },
      props: {
        run: {
          events: [],
          id: "run",
          startTime: "2026-08-23T09:04:10.000Z",
          status: "completed",
          steps: [{
            events: [],
            id: "prepare",
            name: "Prepare Agent invocation",
            startTime: "2026-08-23T09:04:10.000Z",
            status: "completed",
            type: "run",
          }],
        },
      },
    });

    expect(wrapper.get("button").attributes("type")).toBe("button");
    expect(wrapper.get("article").attributes("aria-label")).toBe("Prepare Agent invocation");
  });
});
