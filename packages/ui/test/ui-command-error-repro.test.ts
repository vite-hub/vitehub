// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocation } from "../src/components/agent-invocation.ts";
import type { AgentInvocationView } from "../src/types.ts";

function view(error: unknown): AgentInvocationView {
  const timestamp = "2026-10-11T00:00:00.000Z";
  return {
    id: "repro", traceId: "trace", createdAt: timestamp, updatedAt: timestamp,
    status: "failed", observations: [{
      attributes: { "tool.error": error, "tool.input": { command: "echo hi" }, "tool.id": "command", "tool.name": "shell" },
      name: "agent.tool.error", sequence: 1, timestamp, type: "error",
    }],
  };
}

describe("ui command error repro", () => {
  it.each([
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), '"self": "[Circular]"'],
    ["bigint", { count: 1n }, '"count": "1n"'],
    ["throwing toJSON", { toJSON() { throw new Error("cannot serialize"); } }, "Unable to display payload: cannot serialize"],
  ])("renders %s command errors without crashing", (_name, error, expected) => {
    const wrapper = mount(AgentInvocation, { props: { invocation: view(error) } });
    expect(wrapper.text()).toContain(expected);
  });
});
