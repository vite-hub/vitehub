<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";
import { computed, ref, watch } from "vue";
import {
  isDeniedApproval,
  isLifecycleStartObservation,
  isLifecycleTerminalObservation,
  isStandaloneFailureObservation,
  standaloneSuccessfulLifecycleSequences,
  isTerminalToolObservation,
  isTerminalTaskObservation,
  invocationTerminalNames,
  lifecycleTerminalNames,
  pairedLifecycleTerminal,
  pairedToolTerminal,
  traceDurationMs,
  traceEventId,
  traceSpanEndMs,
  traceStartBoundaryMs,
} from "./console-session-trace-model";

type Observation = AgentInvocationView["observations"][number];
type SpanStatus = "cancelled" | "completed" | "failed" | "recovered" | "running";

type TraceSpan = {
  activityId: string;
  attributes: Record<string, unknown>;
  depth: number;
  description?: string;
  durationMs: number;
  endMs: number;
  eventNames: string[];
  icon: string;
  id: string;
  name: string;
  operation: string;
  sequence: number;
  startMs: number;
  status: SpanStatus;
};

const props = defineProps<{ invocation: AgentInvocationView }>();
const emit = defineEmits<{ focusActivity: [activityId: string] }>();
const spanQuery = ref("");
const fieldQuery = ref("");
const selectedSpanId = ref<string>();
const copied = ref(false);

const spans = computed(() => buildSpans(props.invocation));
const traceStartMs = computed(() =>
  traceStartBoundaryMs(
    timestamp(props.invocation.startedAt || props.invocation.createdAt),
    spans.value.map((span) => span.startMs),
  ),
);
const traceEndMs = computed(() =>
  Math.max(
    timestamp(
      props.invocation.completedAt ||
        props.invocation.failedAt ||
        props.invocation.cancelledAt ||
        props.invocation.updatedAt,
    ),
    ...spans.value.map((span) => traceSpanEndMs(span.startMs, span.endMs, span.durationMs)),
  ),
);
const traceDurationMs = computed(() => Math.max(1, traceEndMs.value - traceStartMs.value));
const filteredSpans = computed(() => {
  const query = spanQuery.value.trim().toLowerCase();
  if (!query) return spans.value;
  return spans.value.filter((span) => spanSearchText(span).includes(query));
});
const selectedSpan = computed(
  () => spans.value.find((span) => span.id === selectedSpanId.value) ?? spans.value[0],
);
const selectedAttributes = computed(() =>
  selectedSpan.value
    ? {
        "span.id": selectedSpan.value.id,
        "trace.id": props.invocation.traceId,
        "span.operation": selectedSpan.value.operation,
        "span.status": selectedSpan.value.status,
        "span.start_time": new Date(selectedSpan.value.startMs).toISOString(),
        "span.end_time": new Date(
          traceSpanEndMs(
            selectedSpan.value.startMs,
            selectedSpan.value.endMs,
            selectedSpan.value.durationMs,
          ),
        ).toISOString(),
        "span.duration_ms": selectedSpan.value.durationMs,
        "span.events": selectedSpan.value.eventNames,
        ...selectedSpan.value.attributes,
      }
    : {},
);
const filteredAttributes = computed(() => {
  const query = fieldQuery.value.trim().toLowerCase();
  return Object.entries(selectedAttributes.value).filter(
    ([key, value]) => !query || `${key} ${searchable(value)}`.toLowerCase().includes(query),
  );
});
const ticks = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map((position) => ({
    label: formatAxis(traceDurationMs.value * position),
    position,
  })),
);

watch(
  spans,
  (value) => {
    if (!value.some((span) => span.id === selectedSpanId.value))
      selectedSpanId.value = value[0]?.id;
  },
  { immediate: true },
);

watch(selectedSpanId, () => {
  fieldQuery.value = "";
  copied.value = false;
});

function buildSpans(invocation: AgentInvocationView): TraceSpan[] {
  const observations = [...invocation.observations].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const starts = traceStarts(observations);
  const pairs = starts.map((start) => ({
    finish: pairedTerminal(start, observations, invocation),
    start,
  }));
  const result = pairs.map(({ start, finish }) => pairedSpan(start, finish, invocation));
  const representedSequences = new Set(
    pairs.flatMap(({ finish }) => (finish ? [finish.sequence] : [])),
  );
  const standaloneSuccessfulTerminals = standaloneSuccessfulLifecycleSequences(
    observations,
    representedSequences,
  );

  for (const observation of observations) {
    const failed = isStandaloneFailureObservation(observation.name);
    const successfulTerminal = standaloneSuccessfulTerminals.has(observation.sequence);
    const successfulTool = successfulTerminal && isTerminalToolObservation(observation.name);
    const cancelledTool =
      isTerminalToolObservation(observation.name) &&
      (observation.name.endsWith(".abort") ||
        observation.name.endsWith(".cancel") ||
        observation.name.endsWith(".cancelled"));
    const terminalTool =
      isTerminalToolObservation(observation.name) &&
      (failed || cancelledTool) &&
      isLifecycleTerminalObservation(observation.name);
    if (!failed && !successfulTerminal && !terminalTool) continue;
    const id = eventId(observation);
    if (representedSequences.has(observation.sequence)) continue;
    const at = timestamp(observation.timestamp);
    const recovered =
      observation.attributes?.["error.recoverable"] === true && invocation.status === "completed";
    const cancelled =
      observation.name === "agent.task.cancelled" ||
      observation.name.endsWith(".abort") ||
      observation.name.endsWith(".cancel") ||
      observation.name.endsWith(".cancelled");
    const operation =
      successfulTool || terminalTool
        ? "execute_tool"
        : isTerminalTaskObservation(observation.name)
          ? "run_task"
          : successfulTerminal
            ? operationName(observation, observation.attributes ?? {})
            : "error";
    const target = operationTarget(operation, observation.attributes ?? {}, invocation);
    const durationMs =
      successfulTool || terminalTool
        ? Math.max(0, traceDurationMs(operation, observation.attributes ?? {}, 0))
        : 0;
    result.push({
      activityId: activityId(observation),
      attributes: { ...observation.attributes },
      depth: 1,
      durationMs,
      endMs: at,
      eventNames: [observation.name],
      icon: successfulTerminal
        ? spanIcon(operation)
        : cancelled
          ? "i-lucide-ban"
          : recovered
            ? "i-lucide-circle-check"
            : "i-lucide-circle-alert",
      id: `${id}:${successfulTerminal ? "terminal" : "error"}:${observation.sequence}`,
      name: target
        ? `${operation} ${target}`
        : recovered && observation.name === "agent.stream.error"
          ? "Stream recovered"
          : humanize(observation.name),
      operation: recovered ? "recovery" : operation,
      sequence: observation.sequence,
      startMs: at - durationMs,
      status: successfulTerminal
        ? "completed"
        : cancelled
          ? "cancelled"
          : recovered
            ? "recovered"
            : "failed",
    });
  }

  if (!result.some((span) => span.operation === "invoke_agent"))
    result.unshift(invocationSpan(invocation, observations));
  return result.sort(
    (left, right) =>
      left.depth - right.depth || left.startMs - right.startMs || left.sequence - right.sequence,
  );
}

function traceStarts(observations: Observation[]): Observation[] {
  const starts: Observation[] = [];
  const openTools = new Map<string, number>();
  for (const observation of observations) {
    const id = eventId(observation);
    if (
      observation.name.startsWith("agent.tool.") &&
      isLifecycleStartObservation(observation.name)
    ) {
      const openIndex = openTools.get(id);
      if (openIndex === undefined) {
        openTools.set(id, starts.push(observation) - 1);
      } else {
        const start = starts[openIndex]!;
        starts[openIndex] = {
          ...start,
          attributes: { ...start.attributes, ...observation.attributes },
        };
      }
      continue;
    }
    if (
      isTerminalToolObservation(observation.name) &&
      isLifecycleTerminalObservation(observation.name)
    )
      openTools.delete(id);
    if (
      isLifecycleStartObservation(observation.name) ||
      observation.name === "agent.approval.request"
    )
      starts.push(observation);
  }
  return starts;
}

function pairedSpan(
  start: Observation,
  finish: Observation | undefined,
  invocation: AgentInvocationView,
): TraceSpan {
  const id = eventId(start);
  const attributes = { ...start.attributes, ...finish?.attributes };
  const startMs = timestamp(start.timestamp);
  const observedEndMs = finish ? timestamp(finish.timestamp) : timestamp(invocation.updatedAt);
  const operation = operationName(start, attributes);
  const target = operationTarget(operation, attributes, invocation);
  const status = spanStatus(finish, attributes, invocation, operation);
  const durationMs = Math.max(0, traceDurationMs(operation, attributes, observedEndMs - startMs));
  const endMs = traceSpanEndMs(startMs, observedEndMs, durationMs);
  return {
    activityId: activityId(start),
    attributes,
    depth: operation === "invoke_agent" ? 0 : 1,
    description: spanDescription(attributes),
    durationMs,
    endMs,
    eventNames: [start.name, ...(finish ? [finish.name] : [])],
    icon: spanIcon(operation),
    id: `${id}:${start.sequence}`,
    name: target ? `${operation} ${target}` : operation,
    operation,
    sequence: start.sequence,
    startMs,
    status,
  };
}

function pairedTerminal(
  start: Observation,
  observations: Observation[],
  invocation: AgentInvocationView,
): Observation | undefined {
  const terminalNames =
    start.name === "agent.invocation.start"
      ? invocationTerminalNames(invocation.status)
      : start.name === "agent.task.started"
      ? ["agent.task.completed", "agent.task.failed", "agent.task.cancelled"]
      : start.name === "agent.approval.request"
        ? ["agent.approval.decision"]
        : lifecycleTerminalNames(start.name);
  if (start.name.startsWith("agent.tool.") && isLifecycleStartObservation(start.name))
    return pairedToolTerminal(start, observations);
  return pairedLifecycleTerminal(start, observations, terminalNames);
}

function invocationSpan(invocation: AgentInvocationView, observations: Observation[]): TraceSpan {
  const start = observations.find((observation) => observation.name === "agent.invocation.start");
  const finish = observations.find((observation) => observation.name === "agent.invocation.finish");
  const startMs = timestamp(start?.timestamp || invocation.startedAt || invocation.createdAt);
  const endMs = timestamp(
    finish?.timestamp ||
      invocation.completedAt ||
      invocation.failedAt ||
      invocation.cancelledAt ||
      invocation.updatedAt,
  );
  return {
    activityId: start ? activityId(start) : invocation.id,
    attributes: { ...start?.attributes, ...finish?.attributes },
    depth: 0,
    durationMs: Math.max(
      0,
      numeric(finish?.attributes?.["invocation.durationMs"]) ?? endMs - startMs,
    ),
    endMs,
    eventNames: [start?.name, finish?.name].filter((value): value is string => Boolean(value)),
    icon: "i-lucide-bot",
    id: stringAttribute(start, "agent.invocation.id") || invocation.id,
    name: `invoke_agent ${invocation.agentName || "agent"}`,
    operation: "invoke_agent",
    sequence: start?.sequence ?? 0,
    startMs,
    status:
      invocation.status === "failed"
        ? "failed"
        : invocation.status === "cancelled"
          ? "cancelled"
          : invocation.status === "running" || invocation.status === "pending"
            ? "running"
            : "completed",
  };
}

function eventId(observation: Observation) {
  return traceEventId(observation);
}

function activityId(observation: Observation) {
  const attributes = observation.attributes ?? {};
  const messageId = attributes["message.id"];
  return String(
    attributes["step.id"] ??
      attributes["tool.id"] ??
      attributes["approval.id"] ??
      attributes["model.call.id"] ??
      (messageId
        ? `${String(messageId)}:${String(attributes["message.phase"] ?? "message")}`
        : `observation:${observation.sequence}`),
  );
}

function operationName(observation: Observation, attributes: Record<string, unknown>) {
  const explicit = attributes["gen_ai.operation.name"];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate strings at the display boundary.
  if (typeof explicit === "string" && explicit) return explicit;
  if (observation.name.startsWith("agent.invocation.")) return "invoke_agent";
  if (observation.name.startsWith("agent.tool.")) return "execute_tool";
  if (observation.name.startsWith("agent.approval.")) return "tool_approval";
  if (observation.name.startsWith("agent.task.")) return "run_task";
  return observation.name.replace(/\.(start|started|finish|completed)$/, "");
}

function operationTarget(
  operation: string,
  attributes: Record<string, unknown>,
  invocation: AgentInvocationView,
) {
  if (operation === "invoke_agent") return invocation.agentName || "agent";
  const keys =
    operation === "execute_tool"
      ? ["gen_ai.tool.name", "tool.name"]
      : operation === "tool_approval"
        ? ["approval.name"]
        : ["gen_ai.request.model", "model.id", "agent.name"];
  for (const key of keys) {
    const value = attributes[key];
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate strings at the display boundary.
    if (typeof value === "string" && value) return value;
  }
}

function spanStatus(
  finish: Observation | undefined,
  attributes: Record<string, unknown>,
  invocation: AgentInvocationView,
  operation: string,
): SpanStatus {
  if (isDeniedApproval(operation, attributes)) return "failed";
  if (operation === "invoke_agent")
    return invocation.status === "failed"
      ? "failed"
      : invocation.status === "cancelled"
        ? "cancelled"
        : finish
          ? "completed"
          : "running";
  if (finish?.name.endsWith(".error")) return "failed";
  if (finish?.name.endsWith(".failed")) return "failed";
  if (
    finish?.name.endsWith(".abort") ||
    finish?.name.endsWith(".cancel") ||
    finish?.name.endsWith(".cancelled")
  )
    return "cancelled";
  if (!finish)
    return invocation.status === "failed"
      ? "failed"
      : invocation.status === "cancelled"
        ? "cancelled"
        : invocation.status === "completed"
          ? "completed"
          : "running";
  const rawOutput = record(attributes["tool.output"]);
  const output = record(rawOutput?.item) ?? rawOutput;
  const exitCode = numeric(output?.exitCode);
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate the error field before classifying the span.
  return (exitCode !== undefined && exitCode !== 0) ||
    typeof attributes["error.message"] === "string"
    ? "failed"
    : "completed";
}

function spanDescription(attributes: Record<string, unknown>) {
  const rawInput = record(attributes["tool.input"]);
  const input = record(rawInput?.item) ?? rawInput;
  const command = input?.command;
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate strings at the display boundary.
  if (typeof command === "string") return compact(command, 90);
  const path = attributes["tool.path"];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate strings at the display boundary.
  return typeof path === "string" ? path : undefined;
}

function spanIcon(operation: string) {
  if (operation === "invoke_agent") return "i-lucide-bot";
  if (operation === "chat") return "i-lucide-message-square-more";
  if (operation === "execute_tool") return "i-lucide-wrench";
  if (operation === "tool_approval") return "i-lucide-shield-check";
  return "i-lucide-layers-3";
}

function barStyle(span: TraceSpan) {
  const left = Math.max(
    0,
    Math.min(100, ((span.startMs - traceStartMs.value) / traceDurationMs.value) * 100),
  );
  const width = Math.max(0, Math.min(100 - left, (span.durationMs / traceDurationMs.value) * 100));
  return { left: `${left}%`, width: `max(3px, ${width}%)` };
}

function spanSearchText(span: TraceSpan) {
  return `${span.name} ${span.description || ""} ${span.eventNames.join(" ")} ${searchable(span.attributes)}`.toLowerCase();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringAttribute(observation: Observation | undefined, key: string) {
  const value = observation?.attributes?.[key];
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate strings at the display boundary.
  return typeof value === "string" ? value : undefined;
}

function numeric(value: unknown) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so validate finite numbers at the display boundary.
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: Date | string | undefined) {
  const result = value instanceof Date ? value.valueOf() : Date.parse(value || "");
  return Number.isFinite(result) ? result : Date.now();
}

function formatDuration(durationMs: number) {
  if (durationMs < 1) return "<1ms";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${trim(durationMs / 1_000, durationMs < 10_000 ? 2 : 1)}s`;
  return formatMinutes(durationMs);
}

function formatAxis(durationMs: number) {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${trim(durationMs / 1_000, 1)}s`;
  return formatMinutes(durationMs);
}

function formatMinutes(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function trim(value: number, digits: number) {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function shortId(value: string) {
  return value.replace(/^sha256_/, "").slice(0, 16);
}

function humanize(value: string) {
  return value.replaceAll(".", " ").replaceAll("_", " ");
}

function compact(value: string, limit: number) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

function searchable(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function displayValue(value: unknown) {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Observation attributes are untrusted persisted telemetry, so preserve string quoting in the inspector.
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function copyAttributes() {
  const value = JSON.stringify(selectedAttributes.value, null, 2);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1_500);
}
</script>

<template>
  <section class="session-trace">
    <div class="session-trace__waterfall">
      <div class="session-trace__search">
        <UInput
          v-model="spanQuery"
          icon="i-lucide-search"
          placeholder="Search spans"
          size="sm"
          variant="outline"
          :ui="{ base: 'w-full' }"
        />
        <span>{{ filteredSpans.length }} spans</span>
      </div>

      <div class="session-trace__table-scroll">
        <div class="session-trace__table">
          <div class="session-trace__table-head">
            <strong>Name</strong>
            <div class="session-trace__axis">
              <span
                v-for="tick in ticks"
                :key="tick.position"
                :style="{ left: `${tick.position * 100}%` }"
                >{{ tick.label }}</span
              >
            </div>
          </div>
          <div class="session-trace__rows">
            <button
              v-for="span in filteredSpans"
              :key="span.id"
              type="button"
              class="session-trace__row"
              :data-selected="selectedSpan?.id === span.id"
              :data-status="span.status"
              @click="
                selectedSpanId = span.id;
                emit('focusActivity', span.activityId);
              "
            >
              <span
                class="session-trace__name"
                :style="{ paddingInlineStart: `${0.75 + span.depth * 1.65}rem` }"
              >
                <UIcon :name="span.icon" />
                <span
                  ><strong>{{ span.name }}</strong
                  ><small v-if="span.description">{{ span.description }}</small></span
                >
              </span>
              <span class="session-trace__timeline">
                <i
                  v-for="tick in ticks"
                  :key="tick.position"
                  :style="{ left: `${tick.position * 100}%` }"
                />
                <span
                  class="session-trace__bar"
                  :data-wide="span.durationMs / traceDurationMs > 0.16"
                  :style="barStyle(span)"
                  ><span>{{ formatDuration(span.durationMs) }}</span></span
                >
              </span>
            </button>
            <div v-if="filteredSpans.length === 0" class="session-trace__empty">
              No spans match this search.
            </div>
          </div>
        </div>
      </div>
    </div>

    <aside v-if="selectedSpan" class="session-trace__detail">
      <header class="session-trace__detail-head">
        <strong><i :data-status="selectedSpan.status" />Span {{ shortId(selectedSpan.id) }}</strong>
        <button type="button" @click="copyAttributes">
          <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" />{{
            copied ? "Copied" : "Copy attributes"
          }}
        </button>
      </header>
      <section class="session-trace__summary">
        <span>{{ selectedSpan.operation.replaceAll("_", " ") }} · {{ selectedSpan.status }}</span>
        <h3><UIcon :name="selectedSpan.icon" />{{ selectedSpan.name }}</h3>
        <dl>
          <div>
            <dt>Duration</dt>
            <dd>{{ formatDuration(selectedSpan.durationMs) }}</dd>
          </div>
          <div>
            <dt>Trace ID</dt>
            <dd>
              <code>{{ shortId(invocation.traceId) }}</code>
            </dd>
          </div>
          <div>
            <dt>Span ID</dt>
            <dd>
              <code>{{ shortId(selectedSpan.id) }}</code>
            </dd>
          </div>
        </dl>
      </section>
      <div class="session-trace__field-search">
        <UInput
          v-model="fieldQuery"
          icon="i-lucide-search"
          placeholder="Search fields…"
          size="sm"
          variant="outline"
        />
      </div>
      <div class="session-trace__fields">
        <section v-for="[key, value] in filteredAttributes" :key="key">
          <span>{{ key }}</span>
          <pre>{{ displayValue(value) }}</pre>
        </section>
        <div v-if="filteredAttributes.length === 0" class="session-trace__empty">
          No fields match this search.
        </div>
      </div>
    </aside>
  </section>
</template>
