<script setup lang="ts">
import { consoleNumber } from "../client/format";
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import * as v from "valibot";

import { useRoute, useRouter } from "vue-router";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { requestConsole } from "../client/request";
import ConsoleState from "./console-state.vue";
import ConsoleUsageChart from "./console-usage-chart.vue";
import ConsoleUsageModelDetail from "./console-usage-model-detail.vue";
import ConsoleUsageShareBar from "./console-usage-share-bar.vue";
import {
  consoleUsageCacheHitRate,
  consoleUsageMetricValue,
  consoleUsageModelShare,
  consoleUsageChartPoint,
  consoleUsageTokenSegments,
  formatConsoleUsageCost as formatCost,
  formatConsoleUsageCostEvidence as formatCostEvidence,
  formatConsoleUsageDateTime as formatDateTime,
  formatConsoleUsagePeriod as formatPeriod,
  formatConsoleUsageShare,
  formatConsoleUsageTimestamp as formatTimestamp,
  formatConsoleUsageTokenEvidence as formatTokenEvidence,
  formatConsoleUsageTokens as formatTokens,
  formatConsoleUsageValue,
  sortConsoleUsageModels,
  type ConsoleUsageChartPoint,
  type ConsoleUsageMetric as UsageMetric,
} from "./console-usage-model";

type UsageBreakdown = "model" | "time";
type UsageSection = "overview" | "sessions" | "accounts";
type UsageWindow = "24h" | "7d" | "14d" | "30d" | "90d";
const usageTotalsEntries = {
  cacheWriteTokens: v.number(),
  cacheWriteTokensAvailable: v.boolean(),
  cachedInputTokens: v.number(),
  cachedInputTokensAvailable: v.boolean(),
  costAvailable: v.boolean(),
  costEstimated: v.boolean(),
  costUsd: v.string(),
  averageCostUsd: v.optional(v.string()),
  pricedInvocations: v.number(),
  inputTokens: v.number(),
  inputTokensAvailable: v.boolean(),
  invocations: v.number(),
  invocationsAvailable: v.boolean(),
  outputTokens: v.number(),
  outputTokensAvailable: v.boolean(),
  reasoningTokens: v.number(),
  reasoningTokensAvailable: v.boolean(),
  totalTokens: v.number(),
  totalTokensAvailable: v.boolean(),
};
const usageTotalsSchema = v.object(usageTotalsEntries);
const usageModelSchema = v.object({ ...usageTotalsEntries, model: v.string() });
const usageBucketSchema = v.object({
  ...usageTotalsEntries,
  models: v.array(usageModelSchema),
  start: v.string(),
});
const usageRunSchema = v.object({
  id: v.string(),
  agent: v.string(),
  status: v.string(),
  at: v.string(),
  usage: v.optional(
    v.object({
      model: v.optional(v.string()),
      totalTokens: v.optional(v.number()),
      cost: v.optional(v.object({ usd: v.string(), estimated: v.boolean(), source: v.string() })),
    }),
  ),
});
const usageSessionSchema = v.object({
  id: v.string(),
  agent: v.string(),
  title: v.optional(v.string()),
  status: v.picklist(["completed", "failed", "cancelled"]),
  at: v.string(),
  models: v.array(v.string()),
  partial: v.boolean(),
  totals: usageTotalsSchema,
});
const providerStatusSchema = v.object({
  agents: v.array(
    v.object({
      agent: v.string(),
      provider: v.optional(v.string()),
      account: v.optional(v.object({ id: v.string(), kind: v.picklist(["credential", "account"]) })),
      readiness: v.picklist(["ready", "unavailable", "unknown", "unsupported"]),
      checkedAt: v.string(),
      stale: v.boolean(),
      reason: v.optional(v.string()),
      modelCompatibility: v.optional(v.object({
        status: v.picklist(["ready", "unavailable", "unknown", "unsupported"]),
        reason: v.optional(v.string()),
      })),
      workspaceCapacity: v.optional(v.object({
        status: v.picklist(["ready", "unavailable", "unknown", "unsupported"]),
        reason: v.optional(v.string()),
      })),
      installed: v.optional(v.boolean()),
      authenticated: v.optional(v.boolean()),
      usageLimits: v.optional(
        v.object({
          checkedAt: v.string(),
          windows: v.array(
            v.object({
              id: v.string(),
              label: v.string(),
              usedPercent: v.number(),
              resetsAt: v.optional(v.string()),
            }),
          ),
          unavailable: v.optional(v.object({ reason: v.string() })),
        }),
      ),
    }),
  ),
});
const usageSummarySchema = v.object({
  available: v.boolean(),
  costSupported: v.boolean(),
  agents: v.array(v.object({ ...usageTotalsEntries, agent: v.string() })),
  sessions: v.array(usageSessionSchema),
  sessionCount: v.number(),
  runs: v.array(usageRunSchema),
  expensive: v.array(usageRunSchema),
  cursor: v.optional(v.string()),
  buckets: v.array(usageBucketSchema),
  costAvailable: v.boolean(),
  from: v.string(),
  generatedAt: v.string(),
  models: v.array(usageModelSchema),
  partial: v.boolean(),
  resolution: v.picklist(["day", "hour"]),
  to: v.string(),
  totals: usageTotalsSchema,
});
type UsageTotals = v.InferOutput<typeof usageTotalsSchema>;
type UsageSummary = v.InferOutput<typeof usageSummarySchema>;

const route = useRoute();
const router = useRouter();
const props = defineProps<{ base: string }>();
const emit = defineEmits<{ "open-sessions": [] }>();
function setFilter(key: string, value: string) {
  void router.replace({ query: { ...route.query, [key]: value || undefined } });
}
const window = computed<UsageWindow>({
  get: () => {
    const parsed = v.safeParse(v.picklist(["24h", "7d", "14d", "30d", "90d"]), route.query.window);
    return parsed.success ? parsed.output : "30d";
  },
  set: value => setFilter("window", value),
});
// The section, metric, and breakdown live in the query, so a reload or a shared link keeps the view.
// Each setter keeps the other query values, including the filters.
const section = computed<UsageSection>({
  get: () => {
    const parsed = v.safeParse(v.picklist(["overview", "sessions", "accounts"]), route.query.section);
    return parsed.success ? parsed.output : "overview";
  },
  set: value => setFilter("section", value === "overview" ? "" : value),
});
// An explicit choice stays in the query. Without one, the page shows cost when the Agents record it.
const metric = computed<UsageMetric>({
  get: () => {
    const parsed = v.safeParse(v.picklist(["cost", "sessions", "tokens"]), route.query.metric);
    const requested = parsed.success ? parsed.output : costSupported.value ? "cost" : "tokens";
    return requested === "cost" && !costSupported.value ? "tokens" : requested;
  },
  set: value => setFilter("metric", value),
});
const breakdown = computed<UsageBreakdown>({
  get: () => {
    const parsed = v.safeParse(v.picklist(["model", "time"]), route.query.breakdown);
    return parsed.success ? parsed.output : "model";
  },
  set: value => setFilter("breakdown", value === "model" ? "" : value),
});
// Each tab renders its panel through the item slot, so every tab controls a real `tabpanel`.
const sections = [
  { label: "Overview", value: "overview", slot: "overview" as const },
  { label: "Sessions", value: "sessions", slot: "sessions" as const },
  { label: "Accounts", value: "accounts", slot: "accounts" as const },
];
const summary = ref<UsageSummary>();
const loading = ref(true);
const error = ref<unknown>();
const agent = computed(() => String(route.query.agent || ""));
const selectedAgent = computed({
  get: () => agent.value ? `agent:${agent.value}` : "all",
  set: (value: string) => setFilter("agent", value.startsWith("agent:") ? value.slice(6) : ""),
});
const status = computed({
  get: () => {
    const parsed = v.safeParse(v.picklist(["completed", "failed", "cancelled"]), route.query.status);
    return parsed.success ? parsed.output : "all";
  },
  set: (value: string) => setFilter("status", value === "all" ? "" : value),
});
const search = computed(() => String(route.query.search || "").trim());
const filtered = computed(() => Boolean(agent.value || search.value || status.value !== "all"));
const emptyState = computed(() =>
  filtered.value
    ? {
        "data-usage-empty": "no-match",
        icon: "i-lucide-search-x",
        title: "No sessions match these filters",
        description: `No session from the last ${windowOptions.find(option => option.value === window.value)?.label ?? "period"} matches the search, Agent, and status filters.`,
        actions: [{ label: "Clear filters", icon: "i-lucide-x", color: "neutral" as const, variant: "outline" as const, onClick: clearFilters }],
      }
    : {
        icon: "i-lucide-inbox",
        title: "No sessions in this period",
        description: "Finished Agent sessions appear here with their token and cost evidence.",
      },
);
function clearFilters() {
  clearTimeout(searchTimer);
  searchInput.value = "";
  const { agent: _agent, search: _search, status: _status, ...query } = route.query;
  void router.replace({ query });
}
const searchInput = ref(search.value);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, value => { searchInput.value = value; });
watch(searchInput, value => {
  clearTimeout(searchTimer);
  if (value.trim() === search.value) return;
  searchTimer = setTimeout(() => setFilter("search", value.trim()), 250);
});
const statusOptions = [
  { label: "All statuses", value: "all" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];
const statusIcons = { completed: "i-lucide-check", failed: "i-lucide-x", cancelled: "i-lucide-ban" };
const statusLabels = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
const statuses = ref<v.InferOutput<typeof providerStatusSchema>["agents"]>([]);
const accounts = computed(() => {
  const groups = new Map<string, (typeof statuses.value)[number] & { agents: string[] }>();
  for (const status of statuses.value) {
    const id = status.account ? `${status.provider}:${status.account.id}` : `agent:${status.agent}`;
    const previous = groups.get(id);
    // A failing or stale sample must not be hidden by another agent's ready sample.
    const current = !previous || status.readiness === "unavailable" || (status.readiness === previous.readiness && status.checkedAt > previous.checkedAt) ? status : previous;
    groups.set(id, { ...current, agents: [...(previous?.agents || []), status.agent] });
  }
  return [...groups.values()].filter(status => !agent.value || status.agents.includes(agent.value));
});
const statusError = ref<string>();
const runCursor = ref<string>();
const previousCursors = ref<Array<string | undefined>>([]);
const costSupported = computed(() => summary.value?.costSupported === true);
// A partial total keeps its "recorded" note, but the note is quieter than the number it qualifies.
const totals = computed(() => {
  const value = summary.value;
  if (!value) return [];
  const items = [
    { label: "Sessions", text: `${consoleNumber(value.sessionCount)}${value.totals.invocationsAvailable ? "" : " recorded"}` },
    { label: "Tokens", text: formatTokenEvidence(value.totals.totalTokens, value.totals.totalTokensAvailable) },
  ];
  if (costSupported.value) {
    items.push(
      { label: "Cost", text: formatCostEvidence(value.totals.costUsd, value.totals.costEstimated, value.totals.costAvailable) },
      { label: "Average per priced session", text: value.totals.averageCostUsd === undefined ? "Unavailable" : formatCost(value.totals.averageCostUsd, value.totals.costEstimated) },
    );
  }
  return items.map(({ label, text }) => ({
    label,
    note: text.endsWith(" recorded") ? "recorded" : undefined,
    value: text.replace(/ recorded$/, ""),
  }));
});
const agentOptions = computed(() => [
  { label: "All agents", value: "all" },
  ...[
    ...new Set([
      ...statuses.value.map((status) => status.agent),
      ...(summary.value?.agents.map((item) => item.agent) ?? []),
    ]),
  ]
    .filter(Boolean)
    .sort()
    .map((value) => ({ label: value, value: `agent:${value}` })),
]);
function runRoute(run: { id: string; agent: string }) {
  try {
    return { name: resolveConsoleRouteName(route.name, "vitehub-console-invocation"), params: { agent: encodeAgentRouteParam(run.agent), invocation: run.id } };
  } catch { return undefined; }
}

const historyHeading = useTemplateRef<HTMLElement>("historyHeading");
// The page buttons are disabled while a page loads, so focus moves to the heading at the start of the new rows.
async function showHistoryPage(page: Promise<void>): Promise<void> {
  await page;
  if (error.value) return;
  await nextTick();
  historyHeading.value?.scrollIntoView({ block: "start" });
  historyHeading.value?.focus({ preventScroll: true });
}
function nextRuns() {
  if (loading.value || !summary.value?.cursor) return;
  void showHistoryPage(loadPage({ cursor: summary.value.cursor, previous: [...previousCursors.value, runCursor.value] }));
}
function previousRuns() {
  if (loading.value || !previousCursors.value.length) return;
  void showHistoryPage(loadPage({ cursor: previousCursors.value.at(-1), previous: previousCursors.value.slice(0, -1) }));
}

let request: AbortController | undefined;

// The range picker offers the common views. A link can still ask for 24 hours or 90 days.
const windowOptions: Array<{ label: string; value: UsageWindow }> = [
  { label: "7 days", value: "7d" },
  { label: "14 days", value: "14d" },
  { label: "30 days", value: "30d" },
];
const windowLabels: Record<UsageWindow, string> = { "24h": "24 hours", "7d": "7 days", "14d": "14 days", "30d": "30 days", "90d": "90 days" };
const spendLabel = computed(() => summary.value?.totals.costEstimated === false ? "Spend" : "Est. spend");
const metricOptions = computed<Array<{ label: string; value: UsageMetric }>>(() => [
  { label: "Sessions", value: "sessions" },
  { label: "Tokens", value: "tokens" },
  ...(costSupported.value ? [{ label: spendLabel.value, value: "cost" as const }] : []),
]);
// The big numbers of the period. Each one also picks the metric of the chart and the ranking.
const headline = computed(() => {
  const value = summary.value;
  if (!value) return [];
  return metricOptions.value.map(option => ({
    ...option,
    note: option.value === "cost" && value.totals.costEstimated ? "models.dev prices" : undefined,
    text: option.value === "sessions"
      ? `${consoleNumber(value.sessionCount)}${value.totals.invocationsAvailable ? "" : " recorded"}`
      : formatConsoleUsageValue(value.totals, option.value).replace(/^~/, ""),
  }));
});
/** Neutral steps from the text color, so the share bar reads by rank and never looks like a status color. */
const shareColors = [100, 72, 52, 36, 24, 16].map(percent => `color-mix(in oklab, var(--ui-text-highlighted) ${percent}%, var(--ui-bg))`);
const modelSegments = computed(() => breakdownModels.value
  .map((model, index) => ({ color: shareColors[Math.min(index, shareColors.length - 1)]!, key: model.model, label: model.model, value: consoleUsageMetricValue(model, metric.value) }))
  .filter(segment => segment.value > 0));
const updatedAt = computed(() => summary.value ? formatTimestamp(summary.value.generatedAt) : undefined);
const agentRows = computed(() => (summary.value?.agents ?? []).map(row => ({ agent: row.agent, count: row.invocations })));
const breakdownOptions = computed<Array<{ label: string; value: UsageBreakdown }>>(() => [
  { label: "Model", value: "model" },
  { label: summary.value?.resolution === "hour" ? "Hour" : "Day", value: "time" },
]);
const chartPoints = computed<ConsoleUsageChartPoint[]>(() =>
  (summary.value?.buckets ?? []).map(bucket =>
    consoleUsageChartPoint(bucket.start, bucket, metric.value, summary.value?.resolution ?? "day")),
);
const partialChart = computed(() => chartPoints.value.some(point => point.evidence === "partial"));
const chartTitle = computed(() => `${summary.value?.resolution === "hour" ? "Hourly" : "Daily"} ${metric.value === "cost" ? "spend" : metric.value}`);
// Unknown cost is not zero. When no period has cost evidence, offer the token trend instead.
const tokenEvidence = computed(() => Boolean(summary.value && (summary.value.totals.totalTokensAvailable || summary.value.totals.totalTokens > 0)));
const breakdownBuckets = computed(() =>
  (summary.value?.buckets ?? [])
    .filter(
      (bucket) =>
        bucket.invocations > 0 || bucket.totalTokens > 0 || (Number(bucket.costUsd) || 0) > 0,
    )
    .toReversed(),
);
const breakdownModels = computed(() => sortConsoleUsageModels(summary.value?.models ?? [], metric.value));
// Row bars scale to the largest model, so the ranking reads at a glance.
const breakdownPeak = computed(() =>
  Math.max(0, ...breakdownModels.value.map(model => consoleUsageMetricValue(model, metric.value))),
);
// Header and chart summary show the totals. This grid splits processed tokens by type.
const tokenTypeStats = computed(() => {
  const totals = summary.value?.totals;
  if (!totals) return [];
  return [
    { label: "Input", note: "Including cache", value: totals.inputTokens, available: totals.inputTokensAvailable },
    { label: "Cached input", value: totals.cachedInputTokens, available: totals.cachedInputTokensAvailable },
    { label: "Cache writes", value: totals.cacheWriteTokens, available: totals.cacheWriteTokensAvailable },
    { label: "Output", value: totals.outputTokens, available: totals.outputTokensAvailable },
    { label: "Reasoning", note: "Included in output", value: totals.reasoningTokens, available: totals.reasoningTokensAvailable },
  ];
});
// Agents first, then models. The kind label tells the two apart in one list.
const averageRows = computed(() => [
  ...(summary.value?.agents ?? []).map(row => ({ ...row, key: `agent:${row.agent}`, kind: "Agent", label: row.agent })),
  ...(summary.value?.models ?? []).map(row => ({ ...row, key: `model:${row.model}`, kind: "Model", label: row.model })),
]);
const tokenSegments = computed(() => summary.value ? consoleUsageTokenSegments(summary.value.totals) : undefined);
const cacheHitRate = computed(() => summary.value ? consoleUsageCacheHitRate(summary.value.totals) : null);
const selectedModelName = ref<string>();
const selectedModel = computed(() =>
  summary.value?.models.find(model => model.model === selectedModelName.value),
);
const modelDetailOpen = computed({
  get: () => selectedModel.value !== undefined,
  set: (open: boolean) => { if (!open) selectedModelName.value = undefined; },
});

function modelShare(model: (typeof breakdownModels.value)[number]): string {
  return summary.value ? formatConsoleUsageShare(consoleUsageModelShare(model, summary.value.totals, metric.value)) : "—";
}

function modelBarWidth(model: (typeof breakdownModels.value)[number]): string {
  const recorded = consoleUsageMetricValue(model, metric.value);
  // A short minimum keeps a tiny share visible as a dash, not a dot.
  return recorded > 0 && breakdownPeak.value > 0 ? `max(0.5rem, ${(recorded / breakdownPeak.value) * 100}%)` : "0";
}

function formatValue(totals: UsageTotals): string {
  return formatConsoleUsageValue(totals, metric.value);
}

function formatMetricNumber(value: number): string {
  if (metric.value === "sessions") return value.toLocaleString("en");
  return metric.value === "cost" ? formatCost(String(value)) : formatTokens(value);
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error ? value.message : value ? "Usage could not be loaded." : undefined;
}

async function load(): Promise<void> {
  return loadPage({ cursor: runCursor.value, previous: previousCursors.value });
}

async function refresh(): Promise<void> {
  return loadPage({ cursor: undefined, previous: [] });
}

async function loadPage(page: { cursor: string | undefined; previous: Array<string | undefined> }): Promise<void> {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = undefined;
  try {
    const result = v.parse(
      usageSummarySchema,
      await requestConsole(props.base, {
        query: {
          window: window.value,
          ...(agent.value ? { agent: agent.value } : {}),
          ...(status.value !== "all" ? { status: status.value } : {}),
          ...(search.value ? { search: search.value } : {}),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        },
        signal: controller.signal,
      }),
    );
    if (request !== controller) return;
    summary.value = result;
    runCursor.value = page.cursor;
    previousCursors.value = page.previous;
    error.value = undefined;
  } catch (value) {
    if (value instanceof Object && "name" in value && value.name === "AbortError") return;
    if (request === controller) error.value = value;
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
    }
  }
}

async function loadStatus(): Promise<void> {
  try {
    const result = v.parse(
      providerStatusSchema,
      await requestConsole(props.base.replace(/\/usage$/, "/status")),
    );
    statuses.value = result.agents;
    statusError.value = undefined;
  } catch (error) {
    statusError.value = errorMessage(error);
  }
}
watch(
  [() => props.base, window, agent, status, search],
  () => {
    runCursor.value = undefined;
    previousCursors.value = [];
    summary.value = undefined;
    void load();
  },
  { immediate: true },
);
watch(() => props.base, () => { void loadStatus(); }, { immediate: true });
onBeforeUnmount(() => { request?.abort(); clearTimeout(searchTimer); });
</script>

<template>
  <UDashboardPanel id="console-usage" :ui="{ body: 'min-h-0 overflow-hidden p-0 sm:p-0 gap-0 sm:gap-0' }">
    <template #header>
      <UDashboardNavbar title="Usage" :toggle="false" :ui="{ root: 'border-b border-default' }">
        <template #right>
          <span v-if="updatedAt" class="hidden text-xs text-dimmed tabular-nums sm:inline">Updated {{ updatedAt }}</span>
          <UButton class="md:hidden" aria-label="Open agent sessions" color="neutral" icon="i-lucide-list" label="Sessions" size="sm" variant="ghost" @click="emit('open-sessions')" />
          <UTooltip text="Refresh usage">
            <UButton aria-label="Refresh usage" color="neutral" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :loading="loading" @click="refresh(); loadStatus();" />
          </UTooltip>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="usage-page">
        <main class="usage-page__main" :aria-busy="loading">
          <div class="usage-page__controls">
            <nav class="usage-toggles" aria-label="Usage sections">
              <button v-for="item in sections" :key="item.value" type="button" :data-tab="item.value" :aria-current="section === item.value ? 'page' : undefined" @click="section = item.value as UsageSection">{{ item.label }}</button>
            </nav>
            <span class="usage-toggles__divider" aria-hidden="true" />
            <div class="usage-toggles" role="group" aria-label="Usage period">
              <button v-for="option in windowOptions" :key="option.value" type="button" :aria-pressed="window === option.value" @click="window = option.value">{{ option.label }}</button>
            </div>
          </div>
          <ConsoleState v-if="error" compact :error="error" title="Could not load usage" :retry="load" />
          <p v-if="summary?.partial" class="flex items-start gap-2 text-xs text-muted" role="status">
            <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Some usage is unavailable. Recorded totals include only the evidence received.
          </p>
          <!-- The skeleton has the height of the numbers, so they do not push the page down when they arrive. -->
          <div v-if="!summary && loading" class="usage-headline" role="status" aria-label="Loading usage">
            <div v-for="index in 3" :key="index" class="grid gap-1.5">
              <USkeleton class="h-3.5 w-16" />
              <USkeleton class="h-10 w-28" />
              <USkeleton class="h-3 w-20" />
            </div>
          </div>

          <template v-if="section === 'overview'">
            <UEmpty v-if="summary && !summary.available && summary.totals.invocationsAvailable" v-bind="emptyState" variant="naked" />
            <template v-if="summary?.available">
              <!-- Big numbers with small labels. Each one picks the metric of the chart and the ranking below. -->
              <div class="usage-headline" role="group" aria-label="Usage metric">
                <button
                  v-for="item in headline"
                  :key="item.value"
                  type="button"
                  class="usage-headline__item"
                  :aria-pressed="metric === item.value"
                  @click="metric = item.value"
                >
                  <span class="usage-headline__label">{{ item.label }}</span>
                  <span class="usage-headline__value">{{ item.text.replace(/ recorded$/, "") }}</span>
                  <span class="usage-headline__note">{{ item.text.endsWith(" recorded") ? "recorded" : item.note ?? "" }}&nbsp;</span>
                </button>
              </div>
              <p class="usage-page__caption">
                {{ windowLabels[window] }} · {{ formatPeriod(summary.from, summary.resolution) }} to {{ formatPeriod(summary.to, summary.resolution) }} UTC
                <span v-if="partialChart" class="ms-2 inline-flex items-center gap-1.5 text-default">
                  <span class="size-1.5 rounded-full bg-warning" aria-hidden="true" /> Partial points
                </span>
              </p>

              <section v-if="metric !== 'sessions' && modelSegments.length > 1" aria-label="Share by model" class="usage-share">
                <div role="img" :aria-label="`Share of ${metric === 'cost' ? 'spend' : metric} by model: ${breakdownModels.map(model => `${model.model} ${modelShare(model)}`).join(', ')}`" class="usage-share__bar">
                  <span v-for="segment in modelSegments" :key="segment.key" :style="{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }" :title="`${segment.label} · ${formatMetricNumber(segment.value)}`" />
                </div>
              </section>

              <ConsoleUsageChart
                :points="chartPoints"
                :format="formatMetricNumber"
                :title="chartTitle"
                :value-label="metric === 'cost' ? spendLabel : metric === 'sessions' ? 'Sessions' : 'Tokens'"
                :empty="`No recorded ${metric === 'cost' ? 'spend' : metric} for this period`"
                :unavailable="metric === 'cost' ? 'Spend is unavailable for this period' : 'Usage is unavailable for this period'"
                :from="formatPeriod(summary.from, summary.resolution)"
                :to="formatPeriod(summary.to, summary.resolution)"
              >
                <template #unavailable>
                  <UButton v-if="metric === 'cost' && tokenEvidence" label="Show tokens" color="neutral" variant="outline" size="xs" @click="metric = 'tokens'" />
                </template>
              </ConsoleUsageChart>

              <section class="usage-ranked" aria-labelledby="usage-ranked-heading">
                <header>
                  <h2 id="usage-ranked-heading">{{ breakdown === "model" ? "Models" : summary.resolution === "hour" ? "Hours" : "Days" }}</h2>
                  <div class="usage-toggles usage-toggles--small" role="group" aria-label="Usage breakdown">
                    <button v-for="option in breakdownOptions" :key="option.value" type="button" :aria-pressed="breakdown === option.value" @click="breakdown = option.value">{{ option.label }}</button>
                  </div>
                </header>
                <ol v-if="breakdown === 'model' && summary.models.length" data-slot="usage-model-breakdown">
                  <li class="usage-ranked__head" aria-hidden="true">
                    <span /><span>Model</span><span>Sessions</span><span>{{ metric === "sessions" ? "Tokens" : metricOptions.find(option => option.value === metric)?.label }}</span><span v-if="metric !== 'sessions'">Share</span>
                  </li>
                  <li v-for="(model, index) in breakdownModels" :key="model.model">
                    <span class="usage-ranked__rank">{{ index + 1 }}</span>
                    <span class="usage-ranked__name">
                      <button type="button" :aria-label="`${model.model} usage details`" @click="selectedModelName = model.model">{{ model.model }}</button>
                      <span aria-hidden="true" class="usage-ranked__bar" :style="{ width: modelBarWidth(model) }" />
                    </span>
                    <span>{{ formatTokenEvidence(model.invocations, model.invocationsAvailable) }}</span>
                    <span class="text-highlighted">{{ metric === "sessions" ? formatTokenEvidence(model.totalTokens, model.totalTokensAvailable) : formatValue(model).replace(/^~/, "") }}</span>
                    <span v-if="metric !== 'sessions'">{{ modelShare(model) }}</span>
                  </li>
                </ol>
                <ol v-else-if="breakdown === 'time' && summary.buckets.length">
                  <li class="usage-ranked__head" aria-hidden="true">
                    <span /><span>{{ summary.resolution === "hour" ? "Hour (UTC)" : "Day (UTC)" }}</span><span>Sessions</span><span>Tokens</span><span>{{ costSupported ? spendLabel : "" }}</span>
                  </li>
                  <li v-for="bucket in breakdownBuckets" :key="bucket.start">
                    <span class="usage-ranked__rank" />
                    <span class="usage-ranked__name">{{ formatPeriod(bucket.start, summary.resolution) }}</span>
                    <span>{{ formatTokenEvidence(bucket.invocations, bucket.invocationsAvailable) }}</span>
                    <span class="text-highlighted">{{ formatTokenEvidence(bucket.totalTokens, bucket.totalTokensAvailable) }}</span>
                    <span>{{ costSupported ? formatCostEvidence(bucket.costUsd, bucket.costEstimated, bucket.costAvailable) : "" }}</span>
                  </li>
                </ol>
              </section>

              <section v-if="tokenSegments?.segments.length && summary.totals.totalTokens > 0" aria-label="Tokens by type">
                <ConsoleUsageShareBar
                  label="Tokens by type"
                  :segments="tokenSegments.segments"
                  :format="formatTokens"
                  :note="tokenSegments.complete ? undefined : 'Recorded evidence only. Some sessions did not report every token type. Input can include their cache tokens.'"
                >
                  <template v-if="cacheHitRate !== null" #aside>
                    <span class="text-xs text-muted">Cache hit <span class="text-highlighted tabular-nums">{{ formatConsoleUsageShare(cacheHitRate) }}</span></span>
                  </template>
                </ConsoleUsageShareBar>
                <p v-if="summary.totals.reasoningTokens > 0" class="mt-2 text-xs text-muted">
                  Output includes {{ formatTokenEvidence(summary.totals.reasoningTokens, summary.totals.reasoningTokensAvailable) }} reasoning tokens.
                </p>
              </section>

              <section v-if="costSupported && summary.expensive.length" class="usage-ranked" aria-labelledby="usage-expensive-heading">
                <header>
                  <h2 id="usage-expensive-heading">Most expensive sessions</h2>
                  <span class="text-xs text-dimmed">{{ summary.totals.pricedInvocations }} of {{ summary.totals.invocations }} sessions priced</span>
                </header>
                <ol>
                  <li v-for="(run, index) in summary.expensive" :key="run.id">
                    <span class="usage-ranked__rank">{{ index + 1 }}</span>
                    <span class="usage-ranked__name">
                      <RouterLink v-if="runRoute(run)" :to="runRoute(run)!" :title="run.id">{{ run.usage?.model || run.agent }}</RouterLink>
                      <span v-else :title="run.id">{{ run.usage?.model || run.agent }}</span>
                      <small><time :datetime="run.at" :title="formatDateTime(run.at)">{{ formatTimestamp(run.at) }}</time> · {{ run.agent }}</small>
                    </span>
                    <span class="capitalize">{{ run.status }}</span>
                    <span>{{ run.usage?.totalTokens === undefined ? "Unavailable" : formatTokens(run.usage.totalTokens) }}</span>
                    <span class="text-highlighted">{{ run.usage?.cost ? formatCost(run.usage.cost.usd, run.usage.cost.estimated) : "Unavailable" }}</span>
                  </li>
                </ol>
              </section>
            </template>
          </template>
          <template v-else-if="section === 'sessions'">
            <section v-if="summary" aria-labelledby="session-history-heading">
              <div class="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="session-history-heading" ref="historyHeading" class="scroll-mt-4 text-sm font-semibold outline-none" tabindex="-1">Session history</h2>
                <span class="text-xs text-muted">Newest first</span>
              </div>
              <div v-if="summary.sessions.length" class="overflow-x-auto">
                <table class="w-full min-w-[42rem] table-fixed text-xs" data-slot="session-history">
                  <thead class="text-left text-dimmed">
                    <tr>
                      <th class="h-9 w-[34%] px-3 font-medium" scope="col">Session</th>
                      <th class="h-9 w-[19%] px-3 font-medium" scope="col">Agent / model</th>
                      <th class="h-9 w-[15%] px-3 font-medium" scope="col">Last activity</th>
                      <th class="h-9 w-[13%] px-3 font-medium" scope="col">Status</th>
                      <th class="h-9 px-3 text-right font-medium" scope="col">Tokens</th>
                      <th v-if="costSupported" class="h-9 px-3 text-right font-medium" scope="col">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="session in summary.sessions" :key="session.id" class="border-t border-default hover:bg-elevated/40">
                      <td class="px-3 py-2.5 align-top">
                        <RouterLink v-if="runRoute(session)" :to="runRoute(session)!" class="block truncate font-medium text-highlighted underline-offset-4 hover:underline focus-visible:underline" :title="session.title || session.id">{{ session.title || session.id }}</RouterLink>
                        <span v-else class="block truncate" :title="session.title || session.id">{{ session.title || session.id }}</span>
                      </td>
                      <td class="px-3 py-2.5 align-top"><span class="block truncate" :title="session.agent">{{ session.agent || 'Unknown agent' }}</span><span class="block truncate text-xs text-muted" :title="session.models.join(', ')">{{ session.models.length ? session.models.join(', ') : 'Model unavailable' }}</span></td>
                      <td class="px-3 py-2.5 align-top text-muted"><time :datetime="session.at" :title="formatDateTime(session.at)">{{ formatTimestamp(session.at) }}</time></td>
                      <td class="px-3 py-2.5 align-top"><span class="inline-flex items-center gap-1.5 text-xs" :class="session.status === 'failed' ? 'text-default' : 'text-muted'"><UIcon :name="statusIcons[session.status]" class="size-3.5 shrink-0" :class="session.status === 'failed' ? 'text-error' : ''" aria-hidden="true" />{{ statusLabels[session.status] }}</span></td>
                      <td class="px-3 py-2.5 text-right align-top tabular-nums" :class="session.totals.totalTokensAvailable ? 'text-highlighted' : 'text-muted'">{{ formatTokenEvidence(session.totals.totalTokens, session.totals.totalTokensAvailable) }}</td>
                      <td v-if="costSupported" class="px-3 py-2.5 text-right align-top font-medium tabular-nums" :class="session.totals.costAvailable ? 'text-highlighted' : 'text-muted'">{{ formatCostEvidence(session.totals.costUsd, session.totals.costEstimated, session.totals.costAvailable) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-if="!summary.sessions.length && !summary.totals.invocationsAvailable" class="py-6 text-sm text-muted" role="status">Session history is still loading…</p>
              <UEmpty v-else-if="!summary.sessions.length" v-bind="emptyState" variant="naked" />
              <div v-if="summary.sessions.length || previousCursors.length" class="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
                <span>{{ summary.sessions.length ? `${previousCursors.length * 50 + 1}–${previousCursors.length * 50 + summary.sessions.length} of ${summary.sessionCount}` : `${summary.sessionCount} sessions` }}{{ summary.totals.invocationsAvailable ? '' : ' recorded' }}</span>
                <div class="flex gap-1">
                  <UButton label="Previous" aria-label="Previous history page" color="neutral" variant="ghost" size="xs" :disabled="!previousCursors.length || loading" @click="previousRuns" />
                  <UButton label="Next" aria-label="Next history page" color="neutral" variant="ghost" size="xs" :disabled="!summary.cursor || loading" @click="nextRuns" />
                </div>
              </div>
            </section>
          </template>
          <template v-else>
            <section aria-labelledby="usage-accounts-heading">
              <h2 id="usage-accounts-heading" class="text-sm font-semibold">Provider accounts</h2>
              <p class="mt-0.5 mb-3 text-xs text-muted">Provider limits apply to the shared account or credential. Recorded session tokens and API cost estimates are shown separately.</p>

              <p v-if="statusError" class="flex items-start gap-2 p-3 text-sm" role="status">
                <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                {{ statusError }}
              </p>
              <div v-else class="grid gap-x-8 lg:grid-cols-2">
                <article
                  v-for="status in accounts"
                  :key="status.account?.id || status.agent"
                  class="space-y-3 border-t border-default py-4"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <h3 class="text-sm font-medium">{{ status.provider || "Provider" }} · {{ status.account ? 'Shared credential' : 'Identity unavailable' }}</h3>
                      <p class="text-xs text-muted">{{ status.agents.join(', ') }}</p>
                    </div>
                    <UBadge
                      :color="
                        status.readiness === 'ready' && !status.stale
                          ? 'success'
                          : status.readiness === 'unavailable'
                            ? 'error'
                            : 'neutral'
                      "
                      variant="subtle"
                      >{{ status.stale ? "Stale" : status.readiness }}</UBadge
                    >
                  </div>
                  <p v-if="status.reason" class="text-xs text-muted">{{ status.reason }}</p>
                  <p v-if="status.modelCompatibility" class="text-xs text-muted">
                    Model compatibility: {{ status.modelCompatibility.reason || status.modelCompatibility.status }}
                  </p>
                  <p v-if="status.workspaceCapacity" class="text-xs text-muted">
                    Workspace capacity: {{ status.workspaceCapacity.reason || status.workspaceCapacity.status }}
                  </p>
                  <div class="flex flex-wrap gap-3 text-xs text-muted">
                    <span v-if="status.authenticated !== undefined"
                      >Account: {{ status.authenticated ? "Signed in" : "Signed out" }}</span
                    >
                    <span>Checked <time :datetime="status.checkedAt" :title="formatDateTime(status.checkedAt)">{{ formatTimestamp(status.checkedAt) }}</time></span>
                  </div>
                  <div
                    v-for="limit in status.usageLimits?.windows ?? []"
                    :key="limit.id"
                    class="space-y-1.5"
                  >
                    <div class="flex justify-between gap-3 text-xs">
                      <span>{{ limit.label }}</span
                      ><span class="tabular-nums">{{ limit.usedPercent.toFixed(0) }}% used</span>
                    </div>
                    <progress
                      class="h-1.5 w-full accent-primary"
                      :value="Math.min(100, Math.max(0, limit.usedPercent))"
                      max="100"
                      :aria-label="limit.label"
                    />
                    <p v-if="limit.resetsAt" class="text-xs text-muted">
                      Resets <time :datetime="limit.resetsAt" :title="formatDateTime(limit.resetsAt)">{{ formatTimestamp(limit.resetsAt) }}</time>
                    </p>
                  </div>
                  <p v-if="status.usageLimits?.unavailable" class="text-xs text-muted">
                    Subscription usage
                    {{
                      status.usageLimits.unavailable.reason === "unsupported"
                        ? "is not reported by this provider"
                        : "could not be checked"
                    }}.
                  </p>
                </article>
              </div>
            </section>
          </template>
        <USlideover
          v-model:open="modelDetailOpen"
          :title="selectedModel?.model || 'Model'"
          description="Model usage in this period"
          :ui="{ description: 'sr-only' }"
        >
          <template #body>
            <ConsoleUsageModelDetail
              v-if="summary && selectedModel"
              :model="selectedModel"
              :totals="summary.totals"
              :buckets="summary.buckets"
              :metric="metric"
              :cost-supported="costSupported"
              :resolution="summary.resolution"
              :from="summary.from"
              :to="summary.to"
            />
          </template>
        </USlideover>
        </main>

        <!-- A quiet column for filters, like the sidebar of a usage dashboard. -->
        <aside class="usage-filters" aria-label="Usage filters">
          <UInput v-model="searchInput" type="search" icon="i-lucide-search" placeholder="Search sessions" aria-label="Search sessions" size="sm" variant="ghost" class="w-full" :ui="{ base: 'text-base sm:text-sm' }" />
          <section aria-labelledby="usage-filter-agents">
            <h2 id="usage-filter-agents"><span>Agents</span><small v-if="agentRows.length">{{ agentRows.length }}</small></h2>
            <ul>
              <li>
                <button type="button" :aria-pressed="selectedAgent === 'all'" @click="selectedAgent = 'all'">
                  <span class="usage-filters__check" aria-hidden="true" /><span class="usage-filters__name">All agents</span>
                  <span class="usage-filters__count">{{ summary?.sessionCount ?? "" }}</span>
                </button>
              </li>
              <li v-for="row in agentRows" :key="row.agent">
                <button type="button" :aria-pressed="selectedAgent === `agent:${row.agent}`" @click="selectedAgent = `agent:${row.agent}`">
                  <span class="usage-filters__check" aria-hidden="true" /><span class="usage-filters__name" :title="row.agent">{{ row.agent }}</span>
                  <span class="usage-filters__count">{{ row.count }}</span>
                </button>
              </li>
            </ul>
          </section>
          <section aria-labelledby="usage-filter-status">
            <h2 id="usage-filter-status"><span>Status</span></h2>
            <ul>
              <li v-for="option in statusOptions" :key="option.value">
                <button type="button" :aria-pressed="status === option.value" @click="status = option.value">
                  <span class="usage-filters__check" aria-hidden="true" /><span class="usage-filters__name">{{ option.label }}</span>
                </button>
              </li>
            </ul>
          </section>
          <button v-if="filtered" type="button" class="usage-filters__clear" @click="clearFilters">Clear filters</button>
          <p class="usage-filters__note">Filters apply to every view. Est. spend adds the cost that each session recorded, estimated or reported. <code>vitehub agent usage</code> reads the same data.</p>
        </aside>
      </div>
    </template>
  </UDashboardPanel>
</template>

<style>
/* Usage reads like a dashboard of numbers: text toggles, big tabular figures, hairline rows, and no boxed cards. */
.usage-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16rem;
  height: 100%;
  min-height: 0;
}

.usage-page__main {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  margin-inline: auto;
  max-width: 64rem;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem 3rem;
  width: 100%;
}

.usage-page__controls {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

.usage-toggles {
  display: flex;
  gap: 1rem;
}

.usage-toggles button {
  border-block-end: 1px solid transparent;
  position: relative;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  padding-block: 0.25rem;
  transition: color 150ms ease, border-color 150ms ease;
}

/* The text toggles are short. The hit area grows to 40 px tall and stays inside the 1 rem gap to the next one. */
.usage-toggles button::before {
  content: "";
  inset: -0.5rem -0.375rem;
  position: absolute;
}

.usage-toggles button:hover {
  color: var(--ui-text-highlighted);
}

.usage-toggles button:is([aria-pressed="true"], [aria-current="page"]) {
  border-block-end-color: var(--ui-text-highlighted);
  color: var(--ui-text-highlighted);
}

.usage-toggles--small button {
  font-size: 0.75rem;
}

.usage-toggles__divider {
  background: var(--ui-border);
  height: 1rem;
  width: 1px;
}

.usage-headline {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
}

.usage-headline__item {
  display: grid;
  gap: 0.25rem;
  justify-items: start;
  text-align: start;
}

.usage-headline__label {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

.usage-headline__value {
  color: var(--ui-text-dimmed);
  font-size: 2.25rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  letter-spacing: -0.02em;
  line-height: 2.5rem;
  transition: color 150ms ease;
}

.usage-headline__item:hover .usage-headline__value,
.usage-headline__item[aria-pressed="true"] .usage-headline__value {
  color: var(--ui-text-highlighted);
}

.usage-headline__item[aria-pressed="true"] .usage-headline__label {
  color: var(--ui-text-highlighted);
}

.usage-headline__note {
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
}

.usage-page__caption {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  margin-block-start: -1rem;
}

.usage-share__bar {
  display: flex;
  gap: 2px;
  height: 0.375rem;
}

.usage-share__bar > span {
  min-width: 0.25rem;
  user-select: none;
}

.usage-share__bar > span:first-child {
  border-end-start-radius: 9999px;
  border-start-start-radius: 9999px;
}

.usage-share__bar > span:last-child {
  border-end-end-radius: 9999px;
  border-start-end-radius: 9999px;
}

.usage-ranked > header {
  align-items: baseline;
  display: flex;
  justify-content: space-between;
  margin-block-end: 0.5rem;
}

.usage-ranked h2 {
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 500;
}

.usage-ranked ol {
  list-style: none;
  margin: 0;
  padding: 0;
}

.usage-ranked li {
  align-items: center;
  border-block-start: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  column-gap: 1rem;
  display: grid;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  grid-template-columns: 1.5rem minmax(0, 1fr) 5rem 7rem 4.5rem;
  min-height: 2.75rem;
  padding-block: 0.5rem;
}

.usage-ranked li > span:nth-child(n + 3) {
  text-align: end;
}

.usage-ranked li.usage-ranked__head {
  border-block-start: 0;
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  min-height: 1.5rem;
  padding-block: 0;
}

.usage-ranked__rank {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
}

.usage-ranked__name {
  display: grid;
  gap: 0.375rem;
  justify-items: start;
  min-width: 0;
}

.usage-ranked__name > :is(button, a, span:not(.usage-ranked__bar)) {
  color: var(--ui-text-highlighted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-ranked__name > :is(button, a):hover {
  text-decoration: underline;
  text-underline-offset: 4px;
}

.usage-ranked__name small {
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
}

.usage-ranked__bar {
  background: var(--ui-text-highlighted);
  pointer-events: none;
  border-radius: 9999px;
  height: 2px;
  max-width: 12rem;
}

.usage-filters {
  border-inline-start: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1rem 2rem;
}

.usage-filters h2 {
  align-items: baseline;
  color: var(--ui-text-highlighted);
  display: flex;
  font-size: 0.8125rem;
  font-weight: 500;
  gap: 0.375rem;
  margin-block-end: 0.375rem;
}

.usage-filters h2 small {
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.usage-filters ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.usage-filters li button {
  align-items: center;
  color: var(--ui-text-muted);
  display: flex;
  font-size: 0.8125rem;
  gap: 0.5rem;
  min-height: 2rem;
  text-align: start;
  transition: color 150ms ease;
  width: 100%;
}

.usage-filters li button:hover,
.usage-filters li button[aria-pressed="true"] {
  color: var(--ui-text-highlighted);
}

.usage-filters__check {
  border: 1px solid var(--ui-border-accented);
  border-radius: 0.1875rem;
  flex: none;
  height: 0.75rem;
  width: 0.75rem;
}

[aria-pressed="true"] > .usage-filters__check {
  background: var(--ui-text-highlighted);
  border-color: var(--ui-text-highlighted);
}

.usage-filters__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-filters__count {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.usage-filters__clear {
  align-self: start;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.usage-filters__note {
  border-block-start: 1px solid var(--ui-border);
  color: var(--ui-text-dimmed);
  font-size: 0.6875rem;
  line-height: 1.5;
  padding-block-start: 1rem;
}

/* A narrow screen stacks the filters under the numbers, and the whole page scrolls. */
@media (max-width: 64rem) {
  .usage-page {
    display: block;
    overflow-y: auto;
  }

  .usage-page__main,
  .usage-filters {
    overflow: visible;
  }

  .usage-filters {
    border-block-start: 1px solid var(--ui-border);
    border-inline-start: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .usage-toggles button,
  .usage-headline__value,
  .usage-filters li button {
    transition: none;
  }
}
</style>
