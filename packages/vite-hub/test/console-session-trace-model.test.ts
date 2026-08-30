import { describe, expect, it } from "vitest";

import {
  isDeniedApproval,
  isLifecycleTerminalObservation,
  isStandaloneFailureObservation,
  isStandaloneSuccessfulToolObservation,
  isTerminalToolObservation,
  standaloneSuccessfulToolSequences,
  isTerminalTaskObservation,
  lifecycleTerminalNames,
  traceDurationMs,
  traceEventId,
  traceSpanEndMs,
  traceStartBoundaryMs,
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

  it("includes recorded duration in trace bounds", () => {
    expect(traceSpanEndMs(1_000, 1_000, 42)).toBe(1_042);
    expect(traceSpanEndMs(1_000, 1_100, 42)).toBe(1_100);
  });

  it("includes reconstructed span starts in trace bounds", () => {
    expect(traceStartBoundaryMs(1_000, [1_000, 958])).toBe(958);
    expect(traceStartBoundaryMs(1_000, [])).toBe(1_000);
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

  it("recognizes successful tool terminals without a start", () => {
    expect(isStandaloneSuccessfulToolObservation("agent.tool.finish")).toBe(true);
    expect(isStandaloneSuccessfulToolObservation("agent.tool.start")).toBe(false);
    expect(isStandaloneSuccessfulToolObservation("agent.model.finish")).toBe(false);
  });

  it("recognizes failed tool terminals without a start", () => {
    expect(isTerminalToolObservation("agent.tool.error")).toBe(true);
    expect(isTerminalToolObservation("agent.tool.failed")).toBe(true);
    expect(isTerminalToolObservation("agent.tool.start")).toBe(false);
    expect(isTerminalToolObservation("agent.model.failed")).toBe(false);
  });

  it("recognizes every paired lifecycle terminal suffix", () => {
    for (const suffix of [
      "finish",
      "completed",
      "error",
      "failed",
      "abort",
      "cancel",
      "cancelled",
    ])
      expect(isLifecycleTerminalObservation(`agent.tool.${suffix}`)).toBe(true);
    expect(isLifecycleTerminalObservation("agent.tool.start")).toBe(false);
    expect(lifecycleTerminalNames("agent.tool.start")).toEqual([
      "agent.tool.finish",
      "agent.tool.completed",
      "agent.tool.error",
      "agent.tool.failed",
      "agent.tool.abort",
      "agent.tool.cancel",
      "agent.tool.cancelled",
    ]);
  });

  it("deduplicates successful terminals within each tool lifecycle", () => {
    const observations = [
      { attributes: { "tool.id": "standalone" }, name: "agent.tool.finish", sequence: 1 },
      { attributes: { "tool.id": "standalone" }, name: "agent.tool.finish", sequence: 2 },
      { attributes: { "tool.id": "paired" }, name: "agent.tool.start", sequence: 3 },
      { attributes: { "tool.id": "paired" }, name: "agent.tool.finish", sequence: 4 },
      { attributes: { "tool.id": "paired" }, name: "agent.tool.finish", sequence: 5 },
      { attributes: { "tool.id": "paired" }, name: "agent.tool.start", sequence: 6 },
      { attributes: { "tool.id": "paired" }, name: "agent.tool.finish", sequence: 7 },
    ];

    const representedSequences = new Set([4, 7]);
    const standaloneSequences = standaloneSuccessfulToolSequences(
      observations,
      representedSequences,
    );

    expect(standaloneSequences).toEqual(new Set([1]));
    expect(new Set([...representedSequences, ...standaloneSequences])).toEqual(new Set([1, 4, 7]));
  });
});
