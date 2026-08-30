import { describe, expect, it } from "vitest";

import {
  isDeniedApproval,
  isStandaloneFailureObservation,
  isTerminalTaskObservation,
  traceDurationMs,
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

  it("pairs Agent Invocation lifecycle events by run identity", () => {
    const start = {
      attributes: { "agent.run.id": "run-1" },
      name: "agent.invocation.start",
      sequence: 1,
    };
    const finish = {
      attributes: { "agent.run.id": "run-1" },
      name: "agent.invocation.finish",
      sequence: 2,
    };

    expect(traceEventId(start)).toBe(traceEventId(finish));
  });

  it("uses recorded tool duration before observation timestamps", () => {
    expect(traceDurationMs("execute_tool", { "tool.durationMs": 42 }, 0)).toBe(42);
    expect(traceDurationMs("invoke_agent", { "invocation.durationMs": 17 }, 0)).toBe(17);
    expect(traceDurationMs("execute_tool", {}, 9)).toBe(9);
  });

  it("recognizes terminal Provider task observations without a start", () => {
    expect(isTerminalTaskObservation("agent.task.failed")).toBe(true);
    expect(isTerminalTaskObservation("agent.task.cancelled")).toBe(true);
    expect(isTerminalTaskObservation("agent.task.completed")).toBe(false);
  });

  it("recognizes unpaired failed lifecycle observations", () => {
    expect(isStandaloneFailureObservation("agent.model.failed")).toBe(true);
    expect(isStandaloneFailureObservation("agent.custom-step.failed")).toBe(true);
    expect(isStandaloneFailureObservation("agent.stream.error")).toBe(true);
    expect(isStandaloneFailureObservation("agent.model.completed")).toBe(false);
  });
});
