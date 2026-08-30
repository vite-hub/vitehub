import * as v from "valibot";

export type TraceObservationIdentity = {
  attributes?: Record<string, unknown>;
  name: string;
  sequence: number;
};

const lifecycleTerminalSuffixes = [
  "finish",
  "completed",
  "error",
  "failed",
  "abort",
  "cancel",
  "cancelled",
] as const;
const finiteNumberSchema = v.pipe(
  v.number(),
  v.check((value) => Number.isFinite(value)),
);
const stringSchema = v.string();

export function isLifecycleStartObservation(name: string): boolean {
  return name.endsWith(".start") || name.endsWith(".started");
}

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
    const result = v.safeParse(stringSchema, attributes[key]);
    if (result.success && result.output) return result.output;
  }
  if (
    observation.name.startsWith("agent.invocation.") &&
    (isLifecycleStartObservation(observation.name) ||
      isLifecycleTerminalObservation(observation.name))
  )
    return "agent.invocation";
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
  const result = v.safeParse(finiteNumberSchema, recorded);
  return result.success ? result.output : fallback;
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

export function isStandaloneSuccessfulLifecycleObservation(
  observation: TraceObservationIdentity,
): boolean {
  const attributes = observation.attributes ?? {};
  const hasStepIdentity = [
    "step.id",
    "tool.id",
    "gen_ai.tool.call.id",
    "approval.id",
    "model.call.id",
  ].some((key) => {
    const result = v.safeParse(stringSchema, attributes[key]);
    return result.success && result.output.length > 0;
  });
  return (
    hasStepIdentity &&
    (observation.name.endsWith(".finish") || observation.name.endsWith(".completed"))
  );
}

export function isTerminalToolObservation(name: string): boolean {
  return name.startsWith("agent.tool.") && !isLifecycleStartObservation(name);
}

export function isLifecycleTerminalObservation(name: string): boolean {
  return lifecycleTerminalSuffixes.some((suffix) => name.endsWith(`.${suffix}`));
}

export function lifecycleTerminalNames(startName: string): string[] {
  return lifecycleTerminalSuffixes.map((suffix) =>
    startName.replace(/\.(?:start|started)$/, `.${suffix}`),
  );
}

export function pairedToolTerminal<Observation extends TraceObservationIdentity>(
  start: Observation,
  observations: Observation[],
): Observation | undefined {
  const identity = traceEventId(start);
  const terminalNames = lifecycleTerminalNames(start.name);
  return observations.find(
    (observation) =>
      observation.sequence > start.sequence &&
      terminalNames.includes(observation.name) &&
      traceEventId(observation) === identity,
  );
}

export function pairedLifecycleTerminal<Observation extends TraceObservationIdentity>(
  start: Observation,
  observations: Observation[],
  terminalNames: string[],
): Observation | undefined {
  const identity = traceEventId(start);
  if (!isLifecycleStartObservation(start.name))
    return observations.find(
      (observation) =>
        observation.sequence > start.sequence &&
        terminalNames.includes(observation.name) &&
        traceEventId(observation) === identity,
    );

  const pendingStarts: Observation[] = [];
  for (const observation of observations) {
    if (traceEventId(observation) !== identity) continue;
    if (
      isLifecycleStartObservation(observation.name) &&
      lifecycleTerminalNames(observation.name).some((name) => terminalNames.includes(name))
    ) {
      pendingStarts.push(observation);
      continue;
    }
    if (!terminalNames.includes(observation.name)) continue;
    const pairedStart = pendingStarts.shift();
    if (pairedStart?.sequence === start.sequence) return observation;
  }
  return undefined;
}

export function standaloneSuccessfulLifecycleSequences(
  observations: TraceObservationIdentity[],
  representedSequences: ReadonlySet<number>,
): Set<number> {
  const representedIdentities = new Set<string>();
  const standaloneSequences = new Set<number>();

  for (const observation of observations) {
    const identity = traceEventId(observation);
    if (isLifecycleStartObservation(observation.name)) {
      representedIdentities.delete(identity);
      continue;
    }
    if (!isStandaloneSuccessfulLifecycleObservation(observation)) continue;
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
