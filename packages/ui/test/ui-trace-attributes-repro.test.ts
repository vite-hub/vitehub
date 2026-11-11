// @vitest-environment happy-dom
import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { mount } from "@vue/test-utils";
import vm from "node:vm";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import { TraceRun } from "../src/components/trace-run.ts";

const UIcon = defineComponent({ props: { name: String }, setup: (props) => () => h("span", { "data-icon": props.name }) });

function traceRun(attributes: Record<string, unknown>): TraceRunView {
  const step = { attributes, events: [], id: "step", name: "Step", startTime: "2026-10-11T00:00:00Z", status: "completed", type: "run" } as TraceStepView;
  return { events: [], id: "run", startTime: "2026-10-11T00:00:00Z", status: "completed", steps: [step] };
}

async function attributesText(attributes: Record<string, unknown>): Promise<string> {
  // A parent passes the run, because test utils walk the props of the mounted component and would throw first.
  const run = traceRun(attributes);
  const wrapper = mount(defineComponent({ setup: () => () => h(TraceRun, { defaultOpen: true, run }) }), { attachTo: document.body, global: { components: { UIcon } } });
  await wrapper.get("[data-trace-step] [data-slot=trace-collapsible-trigger]").trigger("click");
  const text = wrapper.get("[data-slot=code-block-content]").text();
  wrapper.unmount();
  return text;
}

describe("ui trace attributes repro", () => {
  it.each([
    ["throwing ownKeys", new Proxy({}, { ownKeys() { throw new Error("cannot inspect"); } }), "Unable to display payload: cannot inspect"],
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), '"self": "[Circular]"'],
    ["bigint", { count: 1n }, '"count": "1n"'],
    ["throwing toJSON", { toJSON() { throw new Error("cannot serialize"); } }, "Unable to display payload: cannot serialize"],
  ])("renders %s trace attributes without crashing", async (_name, attributes, expected) => {
    expect(await attributesText(attributes)).toContain(expected);
  });

  it("keeps the message of a cross-realm Error when serialization fails", async () => {
    const attributes: Record<string, unknown> = vm.runInNewContext("({ toJSON() { throw new Error('cross realm failure'); } })");
    expect(await attributesText(attributes)).toContain("Unable to display payload: cross realm failure");
  });
});
