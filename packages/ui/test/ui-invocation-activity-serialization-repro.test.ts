// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { invocationActivities } from "../src/components/agent-invocation.ts";
import type { AgentInvocationView } from "../src/types.ts";

function invocation(parts: readonly unknown[]): AgentInvocationView {
  return {
    id: "activity-boundary", traceId: "trace", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:01Z",
    status: "completed", observations: [{
      name: "agent.input", type: "run", timestamp: "2026-09-10T00:00:00Z", sequence: 1,
      attributes: { "input.messages": [{ id: "prompt", role: "user", parts }] },
    }],
  };
}

const cyclic: Record<string, unknown> = { kind: "unknown" };
cyclic.self = cyclic;

const cases = [
  ["cyclic", [cyclic], '"self": "[Circular]"'],
  ["BigInt", [{ count: 1n }], '"count": "1n"'],
  ["throwing toJSON", [{ toJSON() { throw new Error("cannot serialize parts"); } }], "[Unable to display payload: cannot serialize parts]"],
] as const;

describe("invocation activity input serialization", () => {
  it.each(cases)("preserves %s inputs without crashing", (_name, parts, expected) => {
    expect(invocationActivities(invocation(parts))[0]?.body).toContain(expected);
  });
});
