// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

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
});
