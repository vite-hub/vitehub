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

export function isDeniedApproval(
  operation: string,
  attributes: Record<string, unknown>,
): boolean {
  return operation === "tool_approval" && attributes["approval.approved"] === false;
}

export function isTerminalTaskObservation(name: string): boolean {
  return name === "agent.task.failed" || name === "agent.task.cancelled";
}
