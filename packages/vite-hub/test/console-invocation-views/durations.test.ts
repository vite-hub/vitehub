// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation, AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { invocation as run, timestamp, tool } from "./fixtures.ts";

function invocation(completedAt: string): AgentInvocationView {
  const startedAt = "2026-08-30T10:00:00.000Z";
  return {
    completedAt,
    createdAt: startedAt,
    id: "long-run",
    observations: [
      { attributes: { "input.prompt": "Migrate the docs." }, name: "agent.invocation.start", sequence: 1, timestamp: startedAt, type: "lifecycle" },
      { attributes: { "tool.id": "read", "tool.name": "read_file", "vitehub.activity.title": "Read 1 file" }, name: "agent.tool.finish", sequence: 2, timestamp: startedAt, type: "run" },
      { attributes: { "message.content": "Done.", "message.id": "answer", "message.role": "assistant" }, name: "agent.message.delta", sequence: 3, timestamp: completedAt, type: "run" },
    ],
    startedAt,
    status: "completed",
    traceId: "trace",
    updatedAt: completedAt,
  };
}

describe("Agent Invocation durations", () => {
  it.each([
    ["2026-08-30T10:59:59.000Z", "Worked for 59m 59s"],
    ["2026-08-30T12:05:03.000Z", "Worked for 2h 5m"],
  ])("shows hours once a run passes one hour (%s)", (completedAt, title) => {
    const wrapper = mount(AgentInvocation, { props: { header: false, invocation: invocation(completedAt) } });
    expect(wrapper.get(".vh-invocation-work__title").text()).toBe(title);
  });

  it("uses the cancellation timestamp for the run duration and the last step", () => {
    const cancelledAt = "2026-08-22T00:01:05.000Z";
    const wrapper = mount(AgentInvocationInspector, { props: { invocation: run(
      [tool("start", "search", "search", {}, { timestamp: "2026-08-22T00:01:00.000Z" })],
      { cancelledAt, startedAt: timestamp, status: "cancelled", updatedAt: cancelledAt },
    ) } });
    expect(wrapper.get(".vh-invocation-inspector__status small").text()).toBe("1m 5s");
    expect(wrapper.get(".vh-invocation-timeline__row").text()).toContain("+1m 0s · 5s");
  });

  it("carries rounded duration seconds into minutes", () => {
    const completedAt = "2026-08-22T00:00:59.500Z";
    const wrapper = mount(AgentInvocationInspector, { props: { invocation: run([], { completedAt, startedAt: timestamp, updatedAt: completedAt }) } });
    expect(wrapper.get(".vh-invocation-inspector__status small").text()).toBe("1m 0s");
  });
});
