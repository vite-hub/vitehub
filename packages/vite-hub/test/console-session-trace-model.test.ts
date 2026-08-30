import { describe, expect, it } from "vitest";

import {
  isDeniedApproval,
  traceEventId,
} from "../src/console/runtime/components/console-session-trace-model";

describe("Console session trace model", () => {
  it("pairs approval requests and decisions by approval identity", () => {
    const request = {
      attributes: { "approval.id": "approval-1" },
      name: "agent.approval.request",
      sequence: 4,
    };
    const decision = {
      attributes: { "approval.approved": false, "approval.id": "approval-1" },
      name: "agent.approval.decision",
      sequence: 8,
    };

    expect(traceEventId(request)).toBe(traceEventId(decision));
    expect(isDeniedApproval("tool_approval", decision.attributes)).toBe(true);
  });
});
