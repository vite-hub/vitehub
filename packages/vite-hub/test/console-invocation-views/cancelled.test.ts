// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";

describe("Agent Invocation cancellation", () => {
  it("names a cancelled run in the work summary", () => {
    const startedAt = "2026-08-30T15:42:03.000Z";
    const cancelledAt = "2026-08-30T15:47:18.000Z";
    const invocation = {
      cancelledAt,
      createdAt: startedAt,
      id: "cancelled",
      observations: [
        { attributes: { "input.prompt": "Find the timeout." }, name: "agent.invocation.start", sequence: 1, timestamp: startedAt, type: "lifecycle" },
        { attributes: { "tool.id": "rg", "tool.name": "exec_command", "vitehub.activity.title": "Ran command" }, name: "agent.tool.finish", sequence: 2, timestamp: startedAt, type: "run" },
        { attributes: { "message.content": "Comparing the runtimes.", "message.id": "a", "message.role": "assistant" }, name: "agent.message.delta", sequence: 3, timestamp: startedAt, type: "run" },
        { attributes: {}, name: "agent.invocation.cancelled", sequence: 4, timestamp: cancelledAt, type: "run" },
      ],
      startedAt,
      status: "cancelled",
      traceId: "trace",
      updatedAt: cancelledAt,
    } satisfies AgentInvocationView;
    const wrapper = mount(AgentInvocation, { props: { header: false, invocation } });

    expect(wrapper.get(".vh-invocation-work__title").text()).toBe("Cancelled after 5m 15s");
  });
});
