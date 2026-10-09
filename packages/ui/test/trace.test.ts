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
  it.each([
    ["cancelled", "neutral", "Cancelled"],
    ["completed", "success", "Completed"],
    ["failed", "error", "Failed"],
    ["running", "info", "Working"],
  ] as const)("uses the shared status treatment for %s runs", (status, color, label) => {
    const wrapper = mount(AgentTrace, {
      global: { components: { UBadge: BadgeStub, UCollapsible: CollapsibleStub } },
      props: {
        run: { events: [], id: "run", startTime: "2026-08-23T09:04:10Z", status, steps: [] },
      },
    });
    const badge = wrapper.get("span[color]");
    expect(badge.attributes("color")).toBe(color);
    expect(badge.text()).toBe(label);
    expect(wrapper.get(".vh-trace__chevron").attributes("aria-hidden")).toBe("true");
  });

  it("names each trace step and keeps the disclosure trigger native", () => {
    const wrapper = mount(AgentTrace, {
      global: { components: { UBadge: BadgeStub, UCollapsible: CollapsibleStub } },
      props: {
        run: {
          events: [],
          id: "run",
          startTime: "2026-08-23T09:04:10.000Z",
          status: "completed",
          steps: [
            {
              events: [],
              id: "prepare",
              name: "Prepare Agent invocation",
              startTime: "2026-08-23T09:04:10.000Z",
              status: "completed",
              type: "run",
            },
          ],
        },
      },
    });

    expect(wrapper.get("button").attributes("type")).toBe("button");
    expect(wrapper.get("article").attributes("aria-label")).toBe("Prepare Agent invocation");
  });

  it("labels unfinished steps and explains an empty trace", () => {
    const global = { components: { UBadge: BadgeStub, UCollapsible: CollapsibleStub } };
    const step = (id: string, status: "completed" | "failed" | "running") => ({
      events: [],
      id,
      name: id,
      startTime: "2026-08-23T09:04:10.000Z",
      status,
      type: "run" as const,
    });
    const wrapper = mount(AgentTrace, {
      global,
      props: {
        run: {
          events: [],
          id: "run",
          startTime: "2026-08-23T09:04:10Z",
          status: "failed",
          steps: [step("prepare", "completed"), step("test", "failed"), step("deploy", "running")],
        },
      },
    });
    expect(
      wrapper
        .findAll("article")
        .map((article) =>
          article.find(".vh-trace__step-status").exists()
            ? article.get(".vh-trace__step-status").text()
            : null,
        ),
    ).toEqual([null, "Failed", "Working"]);

    const empty = mount(AgentTrace, {
      global,
      props: {
        run: {
          events: [],
          id: "run",
          startTime: "2026-08-23T09:04:10Z",
          status: "running",
          steps: [],
        },
      },
    });
    expect(empty.get(".vh-trace__empty").text()).toBe("No steps recorded.");
  });
});
