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

export function isStandaloneCancellationObservation(name: string): boolean {
  return (
    !name.startsWith("agent.invocation.") &&
    (name.endsWith(".abort") || name.endsWith(".cancel") || name.endsWith(".cancelled"))
  );
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
    (observation.name.endsWith(".finish") ||
      observation.name.endsWith(".completed") ||
      observation.name === "agent.approval.decision")
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

export function invocationTerminalNames(
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): string[] {
  if (status === "completed") return ["agent.invocation.finish", "agent.invocation.completed"];
  if (status === "failed") return ["agent.invocation.error", "agent.invocation.failed"];
  if (status === "cancelled")
    return [
      "agent.invocation.abort",
      "agent.invocation.cancel",
      "agent.invocation.cancelled",
      "agent.invocation.error",
      "agent.invocation.failed",
    ];
  return lifecycleTerminalNames("agent.invocation.start");
}

export function invocationSpanStatus(
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): "cancelled" | "completed" | "failed" | "running" {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  return "running";
}

export function invocationOutcomeTimestamp(
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
  timestamps: {
    cancelledAt?: string;
    completedAt?: string;
    failedAt?: string;
    updatedAt?: string;
  },
): string | undefined {
  if (status === "cancelled") return timestamps.cancelledAt ?? timestamps.updatedAt;
  if (status === "completed") return timestamps.completedAt ?? timestamps.updatedAt;
  if (status === "failed") return timestamps.failedAt ?? timestamps.updatedAt;
  return timestamps.updatedAt;
}

export type TraceLifecycle<Observation extends TraceObservationIdentity> = {
  finish: Observation | undefined;
  observations: Observation[];
  start: Observation;
};

type MutableTraceLifecycle<Observation extends TraceObservationIdentity> =
  TraceLifecycle<Observation> & {
    terminalNames: readonly string[];
  };

type PendingLifecycleQueue<Observation extends TraceObservationIdentity> = {
  head: number;
  lifecycles: MutableTraceLifecycle<Observation>[];
};

function pendingLifecycleQueue<Observation extends TraceObservationIdentity>(
  queues: Map<string, Map<string, PendingLifecycleQueue<Observation>>>,
  identity: string,
  terminalName: string,
): PendingLifecycleQueue<Observation> {
  let identityQueues = queues.get(identity);
  if (!identityQueues) {
    identityQueues = new Map();
    queues.set(identity, identityQueues);
  }
  let queue = identityQueues.get(terminalName);
  if (!queue) {
    queue = { head: 0, lifecycles: [] };
    identityQueues.set(terminalName, queue);
  }
  return queue;
}

function appendLifecycleObservation<Observation extends TraceObservationIdentity>(
  lifecycle: MutableTraceLifecycle<Observation>,
  observation: Observation,
) {
  lifecycle.observations.push(observation);
}

/**
 * Pairs and correlates sequence-ordered Trace observations in one indexed pass.
 * Work is linear in the input plus correlated event references, which may be shared
 * when same-identity lifecycles overlap.
 */
export function indexTraceLifecycles<Observation extends TraceObservationIdentity>(
  starts: Observation[],
  observations: Observation[],
  terminalNamesForStart: (start: Observation) => readonly string[],
): TraceLifecycle<Observation>[] {
  const identities = new WeakMap<Observation, string>();
  const identityOf = (observation: Observation) => {
    const cached = identities.get(observation);
    if (cached !== undefined) return cached;
    const identity = traceEventId(observation);
    identities.set(observation, identity);
    return identity;
  };
  const lifecycles: MutableTraceLifecycle<Observation>[] = starts.map((start) => ({
    finish: undefined,
    observations: [],
    start,
    terminalNames: terminalNamesForStart(start),
  }));
  const lifecycleQueues = new Map<string, Map<string, PendingLifecycleQueue<Observation>>>();
  const standaloneQueues = new Map<string, Map<string, PendingLifecycleQueue<Observation>>>();
  let startIndex = 0;

  for (const observation of observations) {
    while (startIndex < lifecycles.length) {
      const lifecycle = lifecycles[startIndex]!;
      if (lifecycle.start.sequence > observation.sequence) break;
      const queues = isLifecycleStartObservation(lifecycle.start.name)
        ? lifecycleQueues
        : standaloneQueues;
      const identity = identityOf(lifecycle.start);
      for (const terminalName of new Set(lifecycle.terminalNames))
        pendingLifecycleQueue(queues, identity, terminalName).lifecycles.push(lifecycle);
      startIndex += 1;
    }

    const identity = identityOf(observation);
    const lifecycleQueue = lifecycleQueues.get(identity)?.get(observation.name);
    if (lifecycleQueue) {
      while (lifecycleQueue.head < lifecycleQueue.lifecycles.length) {
        const lifecycle = lifecycleQueue.lifecycles[lifecycleQueue.head++]!;
        if (lifecycle.finish) continue;
        lifecycle.finish = observation;
        break;
      }
    }
    const standaloneQueue = standaloneQueues.get(identity)?.get(observation.name);
    if (standaloneQueue) {
      while (standaloneQueue.head < standaloneQueue.lifecycles.length) {
        const lifecycle = standaloneQueue.lifecycles[standaloneQueue.head++]!;
        if (!lifecycle.finish) lifecycle.finish = observation;
      }
    }
  }

  const startsBySequence = new Map<number, MutableTraceLifecycle<Observation>[]>();
  const finishesBySequence = new Map<number, MutableTraceLifecycle<Observation>[]>();
  for (const lifecycle of lifecycles) {
    const sequenceStarts = startsBySequence.get(lifecycle.start.sequence) ?? [];
    sequenceStarts.push(lifecycle);
    startsBySequence.set(lifecycle.start.sequence, sequenceStarts);
    if (!lifecycle.finish) continue;
    const sequenceFinishes = finishesBySequence.get(lifecycle.finish.sequence) ?? [];
    sequenceFinishes.push(lifecycle);
    finishesBySequence.set(lifecycle.finish.sequence, sequenceFinishes);
  }

  const activeByIdentity = new Map<string, Set<MutableTraceLifecycle<Observation>>>();
  const activate = (lifecycle: MutableTraceLifecycle<Observation>) => {
    if (!lifecycle.finish || lifecycle.finish.sequence <= lifecycle.start.sequence) return;
    const identity = identityOf(lifecycle.start);
    const active = activeByIdentity.get(identity) ?? new Set();
    active.add(lifecycle);
    activeByIdentity.set(identity, active);
  };
  const deactivate = (lifecycle: MutableTraceLifecycle<Observation>) => {
    const identity = identityOf(lifecycle.start);
    const active = activeByIdentity.get(identity);
    active?.delete(lifecycle);
    if (active?.size === 0) activeByIdentity.delete(identity);
  };

  for (const observation of observations) {
    const identity = identityOf(observation);
    const sequenceStarts = startsBySequence.get(observation.sequence) ?? [];
    const sequenceFinishes = finishesBySequence.get(observation.sequence) ?? [];
    if (isLifecycleStartObservation(observation.name)) {
      for (const lifecycle of sequenceStarts) {
        if (identityOf(lifecycle.start) !== identity) continue;
        appendLifecycleObservation(lifecycle, observation);
        activate(lifecycle);
      }
      continue;
    }
    if (isLifecycleTerminalObservation(observation.name)) {
      for (const lifecycle of sequenceFinishes) appendLifecycleObservation(lifecycle, observation);
      for (const lifecycle of sequenceFinishes) deactivate(lifecycle);
      continue;
    }

    for (const lifecycle of activeByIdentity.get(identity) ?? [])
      appendLifecycleObservation(lifecycle, observation);
    for (const lifecycle of sequenceStarts) {
      if (identityOf(lifecycle.start) !== identity) continue;
      appendLifecycleObservation(lifecycle, observation);
      activate(lifecycle);
    }
    for (const lifecycle of sequenceFinishes) deactivate(lifecycle);
  }

  return lifecycles;
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

export function correlatedLifecycleObservations<Observation extends TraceObservationIdentity>(
  start: Observation,
  finish: Observation | undefined,
  observations: Observation[],
): Observation[] {
  const identity = traceEventId(start);
  const endSequence = finish?.sequence ?? start.sequence;
  return observations.filter(
    (observation) =>
      observation.sequence >= start.sequence &&
      observation.sequence <= endSequence &&
      traceEventId(observation) === identity &&
      (!isLifecycleStartObservation(observation.name) || observation.sequence === start.sequence) &&
      (!isLifecycleTerminalObservation(observation.name) ||
        observation.sequence === finish?.sequence),
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
