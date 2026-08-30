export type TraceObservationIdentity = {
  attributes?: Record<string, unknown>;
  name: string;
  sequence: number;
};

export function traceEventId(observation: TraceObservationIdentity): string {
  const attributes = observation.attributes ?? {};
  for (const key of [
    "step.id",
    "tool.id",
    "gen_ai.tool.call.id",
    "approval.id",
    "model.call.id",
    "agent.run.id",
    "agent.invocation.id",
  ]) {
    const value = attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return `${observation.name}:${observation.sequence}`;
}

export function traceDurationMs(
  operation: string,
  attributes: Record<string, unknown>,
  fallback: number,
): number {
  const recorded =
    operation === "execute_tool"
      ? attributes["tool.durationMs"]
      : attributes["invocation.durationMs"];
  return typeof recorded === "number" && Number.isFinite(recorded) ? recorded : fallback;
}

export function traceSpanEndMs(startMs: number, endMs: number, durationMs: number): number {
  return Math.max(endMs, startMs + durationMs);
}

export function traceStartBoundaryMs(invocationStartMs: number, spanStartMs: number[]): number {
  return Math.min(invocationStartMs, ...spanStartMs);
}

export function isDeniedApproval(operation: string, attributes: Record<string, unknown>): boolean {
  return operation === "tool_approval" && attributes["approval.approved"] === false;
}

export function isTerminalTaskObservation(name: string): boolean {
  return name === "agent.task.failed" || name === "agent.task.cancelled";
}

export function isStandaloneFailureObservation(name: string): boolean {
  return name.endsWith(".error") || name.endsWith(".failed") || isTerminalTaskObservation(name);
}

export function isStandaloneSuccessfulToolObservation(name: string): boolean {
  return name === "agent.tool.finish";
}

export function isTerminalToolObservation(name: string): boolean {
  return name.startsWith("agent.tool.") && name !== "agent.tool.start";
}

export function standaloneSuccessfulToolSequences(
  observations: TraceObservationIdentity[],
  representedSequences: ReadonlySet<number>,
): Set<number> {
  const representedIdentities = new Set<string>();
  const standaloneSequences = new Set<number>();

  for (const observation of observations) {
    const identity = traceEventId(observation);
    if (observation.name === "agent.tool.start") {
      representedIdentities.delete(identity);
      continue;
    }
    if (!isStandaloneSuccessfulToolObservation(observation.name)) continue;
    if (representedSequences.has(observation.sequence)) {
      representedIdentities.add(identity);
      continue;
    }
    if (representedIdentities.has(identity)) continue;
    representedIdentities.add(identity);
    standaloneSequences.add(observation.sequence);
  }

  return standaloneSequences;
}
