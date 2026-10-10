// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { AgentInvocationTimeline, invocationTimeline } from "../src/index.ts";
import type { AgentInvocationView } from "../src/index.ts";

const trace = { id: "trace" };
const invocation: AgentInvocationView = {
  createdAt: "2026-08-23T09:00:00.000Z",
  id: "ainv_timeline",
  observations: [
    { attributes: { "message.content": "Fix it.", "message.id": "u1", "message.role": "user" }, name: "agent.message.recorded", sequence: 1, timestamp: "2026-08-23T09:00:05.000Z", trace, type: "run" },
    { attributes: { "step.id": "vitehub.workspace.prepare.read-files", "vitehub.activity.detail": "12 files", "vitehub.activity.kind": "preparation", "vitehub.activity.title": "Reading workspace files", "workspace.preparation.durationMs": 500 }, name: "vitehub.workspace.prepare.read-files.completed", sequence: 2, timestamp: "2026-08-23T09:00:00.250Z", trace, type: "lifecycle" },
    { attributes: { "tool.durationMs": 41_200, "tool.error": "1 test failed", "tool.id": "tests", "tool.name": "exec_command", "tool.output": { item: { command: "pnpm test", exitCode: 1 } } }, name: "agent.tool.error", sequence: 3, timestamp: "2026-08-23T09:02:49.000Z", trace, type: "error" },
  ],
  startedAt: "2026-08-23T09:00:00.000Z",
  status: "completed",
  traceId: "trace",
  updatedAt: "2026-08-23T09:04:12.000Z",
};

describe("AgentInvocationTimeline", () => {
  it("lists timed steps with their owner, offset, and duration", () => {
    const items = invocationTimeline(invocation);
    expect(items.map(item => [item.owner, item.title, item.timing])).toEqual([
      ["vitehub", "Reading workspace files", "+250ms"],
      ["agent", "Ran command", "+2m 8s · 41.2s"],
    ]);
    // A finish record carries the end time, so the start is the end minus the duration.
    expect(items[1]).toMatchObject({ detail: "pnpm test", durationMs: 41_200, offsetMs: 127_800 });
  });

  it("renders one button per step and emits the activity id", async () => {
    const wrapper = mount(AgentInvocationTimeline, { props: { invocation } });
    const rows = wrapper.findAll(".vh-invocation-timeline__row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.attributes()).toMatchObject({ "data-owner": "vitehub", title: "Reading workspace files — 12 files" });
    expect(rows[1]!.attributes("data-status")).toBe("failed");
    expect(rows[0]!.get(".vh-visually-hidden").text()).toBe("ViteHub:");
    expect(rows[1]!.get(".vh-visually-hidden").text()).toBe("Agent, failed:");
    expect(rows[1]!.get("time").text()).toBe("+2m 8s · 41.2s");
    await rows[1]!.trigger("click");
    expect(wrapper.emitted("selectActivity")).toEqual([["tests"]]);
  });

  it("orders rows by their computed start time", () => {
    const overlapping: AgentInvocationView = {
      ...invocation,
      observations: [
        { attributes: { "tool.durationMs": 1_000, "tool.id": "short", "tool.name": "short" }, name: "agent.tool.completed", sequence: 1, timestamp: "2026-08-23T09:00:03.000Z", trace, type: "run" },
        { attributes: { "tool.durationMs": 4_000, "tool.id": "long", "tool.name": "long" }, name: "agent.tool.completed", sequence: 2, timestamp: "2026-08-23T09:00:05.000Z", trace, type: "run" },
        { attributes: { "tool.durationMs": 5_000, "tool.id": "same-start", "tool.name": "same-start" }, name: "agent.tool.completed", sequence: 3, timestamp: "2026-08-23T09:00:06.000Z", trace, type: "run" },
      ],
    };
    expect(invocationTimeline(overlapping).map(item => [item.id, item.offsetMs])).toEqual([
      ["long", 1_000],
      ["same-start", 1_000],
      ["short", 2_000],
    ]);
  });

  it("shows an empty message or the empty slot without timed steps", () => {
    const empty = { ...invocation, observations: [] };
    expect(mount(AgentInvocationTimeline, { props: { invocation: empty } }).text()).toBe("No timed steps recorded.");
    expect(mount(AgentInvocationTimeline, { props: { invocation: empty }, slots: { empty: () => "Nothing yet" } }).text()).toBe("Nothing yet");
  });
});
