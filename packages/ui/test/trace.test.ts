// @vitest-environment happy-dom

import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";
import { TraceRun } from "../src/components/trace-run.ts";

const UIcon = defineComponent({ props: { name: String }, setup: (props) => () => h("span", { "data-icon": props.name }) });
const global = { components: { UIcon } };

function step(id: string, status: TraceStepView["status"], attributes?: Record<string, unknown>): TraceStepView {
  return { attributes, events: [], id, name: id, startTime: "2026-08-23T09:04:10.000Z", status, type: "run" } as TraceStepView;
}

function run(status: TraceRunView["status"], steps: TraceStepView[] = [], durationMs?: number): TraceRunView {
  return { durationMs, events: [], id: "run", startTime: "2026-08-23T09:04:10Z", status, steps };
}

describe("TraceRun", () => {
  it.each([
    ["cancelled", undefined, "Cancelled · 320 ms"],
    ["completed", undefined, "Completed · 320 ms"],
    ["failed", "error", "Failed · 320 ms"],
    ["running", "running", "Working · 320 ms"],
  ] as const)("shows a %s run as a trace line with its status in text", (status, lineStatus, text) => {
    const wrapper = mount(TraceRun, { global, props: { run: run(status, [], 320) } });
    const line = wrapper.get("[data-slot=trace-collapsible-trigger] [data-slot=trace-line]");

    expect(line.attributes("data-status")).toBe(lineStatus);
    expect(line.get("[data-slot=trace-title]").text()).toBe("Trace run");
    expect(line.get("[data-slot=trace-description]").text()).toBe(text);
    expect(wrapper.get("[data-slot=trace-collapsible-trigger]").element.tagName).toBe("BUTTON");
  });

  it("shows an unknown status from a newer runtime as text", () => {
    const wrapper = mount(TraceRun, { global, props: { run: run("paused" as TraceRunView["status"]) } });
    expect(wrapper.get("[data-slot=trace-description]").text()).toBe("paused");
  });

  it("names each step and expands steps with attributes", async () => {
    const wrapper = mount(TraceRun, {
      attachTo: document.body,
      global,
      props: { defaultOpen: true, run: run("failed", [step("prepare", "completed"), step("test", "failed", { command: "pnpm test" })]) },
      slots: { title: () => "Verification run" },
    });

    expect(wrapper.get("[data-slot=trace-title]").text()).toBe("Verification run");
    const steps = wrapper.findAll("[data-trace-step]");
    expect(steps.map((item) => [item.attributes("aria-label"), item.attributes("role")])).toEqual([["prepare", "group"], ["test", "group"]]);
    expect(steps[1]!.get("[data-slot=trace-line]").attributes("data-status")).toBe("error");

    await steps[1]!.get("[data-slot=trace-collapsible-trigger]").trigger("click");
    expect(steps[1]!.get("[data-slot=code-block-content]").text()).toContain('"command": "pnpm test"');
    wrapper.unmount();
  });

  it("explains an empty run and shows attributes that cannot be serialized", async () => {
    const empty = mount(TraceRun, { global, props: { defaultOpen: true, run: run("running") } });
    expect(empty.get("[data-slot=trace-collapsible-content] [data-slot=trace-line]").attributes("data-status")).toBe("pending");
    expect(empty.text()).toContain("No steps recorded.");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const wrapper = mount(TraceRun, { attachTo: document.body, global, props: { defaultOpen: true, run: run("completed", [step("loop", "completed", cyclic)]) } });
    await wrapper.get("[data-trace-step] [data-slot=trace-collapsible-trigger]").trigger("click");
    expect(wrapper.get("[data-slot=code-block-content]").text()).toBe("[Attributes cannot be shown]");
    wrapper.unmount();

    const throwingKeys = new Proxy({ value: 1 }, { ownKeys: () => { throw new Error("cannot inspect attributes"); } });
    const proxyRun = run("completed");
    const proxyWrapper = mount(TraceRun, { attachTo: document.body, global, props: { defaultOpen: true, run: proxyRun } });
    proxyRun.steps.push(step("proxy", "completed", throwingKeys));
    proxyWrapper.vm.$forceUpdate();
    await proxyWrapper.vm.$nextTick();
    await proxyWrapper.get("[data-trace-step] [data-slot=trace-collapsible-trigger]").trigger("click");
    expect(proxyWrapper.get("[data-slot=code-block-content]").text()).toBe("[Attributes cannot be shown]");
    proxyWrapper.unmount();
  });
});
