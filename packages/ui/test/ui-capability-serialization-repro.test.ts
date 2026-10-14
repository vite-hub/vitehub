// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { AgentCapabilityInspector } from "../src/components/agent-capability-inspector.ts";
import type { AgentInvocationView } from "../src/types.ts";

function invocation(state: unknown, metadata?: unknown, view?: unknown): AgentInvocationView {
  return {
    id: "capability-boundary",
    traceId: "trace",
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:01Z",
    status: "completed",
    observations: [],
    configuration: { capabilities: [{ id: "custom", inspection: { label: "Custom", state: state as never, view: view as never }, metadata: metadata as never }] },
  };
}

const cyclic: Record<string, unknown> = { count: 1 };
cyclic.self = cyclic;

const cases = [
  ["cyclic state", { state: cyclic }, '"self": "[Circular]"'],
  ["BigInt state", { state: { count: 1n } }, '"count": "1n"'],
  ["throwing state", { state: { toJSON() { throw new Error("cannot serialize state"); } } }, "[Unable to display payload: cannot serialize state]"],
  ["cyclic metadata", { state: undefined, metadata: cyclic }, '"self": "[Circular]"'],
  ["BigInt metadata", { state: undefined, metadata: { count: 1n } }, '"count": "1n"'],
  ["throwing metadata", { state: undefined, metadata: { toJSON() { throw new Error("cannot serialize metadata"); } } }, "[Unable to display payload: cannot serialize metadata]"],
] as const;

describe("AgentCapabilityInspector serialization", () => {
  it.each([
    ["string", "plain text"],
    ["number", 42],
    ["boolean", true],
    ["array", [1, 2]],
    ["null", null],
    ["converted scalar", { toJSON: () => 42 }],
  ])("rejects %s state for a valid inspection view", async (_name, state) => {
    const props = invocation(state, undefined, {
      root: "message",
      elements: { message: { type: "Text", props: { text: "Record-only view" } } },
    });
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: props } });
    expect(wrapper.text()).not.toContain("Record-only view");
    expect(wrapper.find(".vh-capability-inspector__empty").exists()).toBe(true);
    wrapper.unmount();
    const html = await renderToString(createSSRApp({ render: () => h(AgentCapabilityInspector, { invocation: props }) }));
    expect(html).not.toContain("Record-only view");
    expect(html).toContain("vh-capability-inspector__empty");
  });
  it.each(cases)("renders %s without crashing", async (_name, values, expected) => {
    const props = values.state === undefined ? invocation(undefined, values.metadata) : invocation(values.state);
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: props } });
    expect(wrapper.findAll("pre").map(pre => pre.text()).join("\n")).toContain(expected);
    wrapper.unmount();
    const html = await renderToString(createSSRApp({ render: () => h(AgentCapabilityInspector, { invocation: props }) }));
    expect(html.replaceAll("&quot;", "\"" )).toContain(expected);
  });
  it("guards hostile state before rendering a valid inspection view", async () => {
    const props = invocation(cyclic, undefined, {
      root: "message",
      elements: { message: { type: "Text", props: { text: "Safe view" } } },
    });
    const wrapper = mount(AgentCapabilityInspector, { props: { invocation: props } });
    expect(wrapper.text()).toContain("Safe view");
    expect(wrapper.text()).not.toContain("[object Object]");
    wrapper.unmount();
    const html = await renderToString(createSSRApp({ render: () => h(AgentCapabilityInspector, { invocation: props }) }));
    expect(html).toContain("Safe view");
  });
});
