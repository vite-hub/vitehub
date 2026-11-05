<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import * as v from "valibot";

import { useRoute, useRouter } from "vue-router";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { requestConsole } from "../client/request";
import ConsolePageToolbar from "./console-page-toolbar.vue";
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
type UsageWindow = "24h" | "7d" | "30d" | "90d";
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
    const parsed = v.safeParse(v.picklist(["24h", "7d", "30d", "90d"]), route.query.window);
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
    const parsed = v.safeParse(v.picklist(["cost", "tokens"]), route.query.metric);
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
    { label: "Sessions", text: `${value.sessionCount.toLocaleString("en")}${value.totals.invocationsAvailable ? "" : " recorded"}` },
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

const windowOptions: Array<{ label: string; value: UsageWindow }> = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
];
const metricOptions = computed<Array<{ label: string; value: UsageMetric }>>(() => [
  ...(costSupported.value ? [{ label: "Cost", value: "cost" as const }] : []),
  { label: "Tokens", value: "tokens" },
]);
const breakdownOptions = computed<Array<{ label: string; value: UsageBreakdown }>>(() => [
  { label: "Model", value: "model" },
  { label: summary.value?.resolution === "hour" ? "Hour" : "Day", value: "time" },
]);
const chartPoints = computed<ConsoleUsageChartPoint[]>(() =>
  (summary.value?.buckets ?? []).map(bucket =>
    consoleUsageChartPoint(bucket.start, bucket, metric.value, summary.value?.resolution ?? "day")),
);
const partialChart = computed(() => chartPoints.value.some(point => point.evidence === "partial"));
const chartTitle = computed(() => `${summary.value?.resolution === "hour" ? "Hourly" : "Daily"} ${metric.value === "cost" ? "cost" : "tokens"}`);
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
  <UDashboardPanel id="console-usage" :ui="{ body: 'min-h-0 overflow-y-auto p-0 sm:p-0 gap-0 sm:gap-0' }">
    <template #header>
      <UDashboardNavbar title="Usage" :toggle="false" :ui="{ root: 'border-b border-default' }">
        <template #right>
          <UButton class="md:hidden" aria-label="Open agent sessions" color="neutral" icon="i-lucide-list" label="Sessions" size="sm" variant="ghost" @click="emit('open-sessions')" />
          <USelect v-model="window" aria-label="Usage period" class="w-28" size="sm" value-key="value" :items="windowOptions" />
          <UButton aria-label="Refresh usage" color="neutral" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :disabled="loading" @click="refresh(); loadStatus();" />
        </template>
      </UDashboardNavbar>
      <ConsolePageToolbar role="search" aria-label="Session history filters" width="6xl">
        <UInput v-model="searchInput" type="search" icon="i-lucide-search" placeholder="Search sessions" aria-label="Search session history" class="min-w-40 flex-1 sm:max-w-72" size="sm" />
        <USelect v-model="selectedAgent" :items="agentOptions" value-key="value" aria-label="Agent" size="sm" class="w-40 max-w-full" />
        <USelect v-model="status" :items="statusOptions" value-key="value" aria-label="Session status" size="sm" class="w-36" />
        <UButton v-if="filtered" label="Clear" color="neutral" variant="ghost" size="sm" @click="clearFilters" />
      </ConsolePageToolbar>
    </template>
    <template #body>
      <main class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6" :aria-busy="loading">
        <ConsoleState v-if="error" compact :error="error" title="Could not load session history" :retry="load" />
        <p v-if="summary?.partial" class="flex items-start gap-2 text-xs text-muted" role="status">
          <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Some usage is unavailable. Recorded totals include only the evidence received.
        </p>
        <template v-if="summary">
          <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-default bg-(--ui-border)" :class="costSupported ? 'sm:grid-cols-4' : 'sm:grid-cols-2'" aria-label="Session history totals">
            <div v-for="total in totals" :key="total.label" class="bg-default px-4 py-3">
              <dt class="text-xs text-muted">{{ total.label }}</dt>
              <dd class="mt-1 flex items-baseline gap-1.5 tabular-nums">
                <span class="text-lg font-semibold text-highlighted">{{ total.value }}</span>
                <span v-if="total.note" class="text-xs text-muted">{{ total.note }}</span>
              </dd>
            </div>
          </dl>
        </template>
        <p v-else-if="loading" class="py-5 text-sm text-muted" role="status">Loading session history…</p>
        <UTabs
          v-model="section"
          :items="sections"
          aria-label="Usage sections"
          color="neutral"
          size="sm"
          :ui="{
            root: 'items-stretch gap-3',
            list: 'w-fit gap-1 bg-transparent p-0',
            indicator: 'hidden',
            trigger: 'rounded-md px-2.5 data-[state=inactive]:text-muted data-[state=inactive]:hover:text-highlighted data-[state=active]:bg-elevated data-[state=active]:text-highlighted',
          }"
        >
          <template #overview>
            <UEmpty v-if="summary && !summary.available && summary.totals.invocationsAvailable" v-bind="emptyState" variant="naked" />
            <div v-if="summary?.available" class="mt-3 flex flex-col gap-8">
              <section class="flex flex-col gap-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 class="text-sm font-semibold">{{ chartTitle }}</h2>
                    <p class="mt-0.5 text-xs text-muted">
                      {{ formatPeriod(summary.from, summary.resolution) }} to {{ formatPeriod(summary.to, summary.resolution) }} UTC
                      <span v-if="partialChart" class="ms-2 inline-flex items-center gap-1.5 text-default">
                        <span class="size-1.5 rounded-full bg-warning" aria-hidden="true" /> Partial points
                      </span>
                    </p>
                  </div>
                  <div class="flex gap-1" role="group" aria-label="Usage metric">
                    <UButton v-for="option in metricOptions" :key="option.value" :label="option.label" color="neutral" size="xs" :variant="metric === option.value ? 'soft' : 'ghost'" :aria-pressed="metric === option.value" @click="metric = option.value" />
                  </div>
                </div>
                <ConsoleUsageChart
                  :points="chartPoints"
                  :format="formatMetricNumber"
                  :title="chartTitle"
                  :value-label="metric === 'cost' ? 'Cost' : 'Tokens'"
                  :empty="`No recorded ${metric} for this period`"
                  :unavailable="metric === 'cost' ? 'Cost is unavailable for this period' : 'Token usage is unavailable for this period'"
                  :from="formatPeriod(summary.from, summary.resolution)"
                  :to="formatPeriod(summary.to, summary.resolution)"
                >
                  <template #unavailable>
                    <UButton
                      v-if="metric === 'cost' && tokenEvidence"
                      label="Show tokens"
                      color="neutral"
                      variant="outline"
                      size="xs"
                      @click="metric = 'tokens'"
                    />
                  </template>
                </ConsoleUsageChart>
              </section>

              <!-- The bar splits input into uncached, cache read, and cache write. Without a consistent split, the totals per type show instead. -->
              <section v-if="tokenSegments?.segments.length && summary.totals.totalTokens > 0" aria-label="Usage mix" class="flex flex-col gap-2">
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
                <p v-if="summary.totals.reasoningTokens > 0" class="text-xs text-muted">
                  Output includes {{ formatTokenEvidence(summary.totals.reasoningTokens, summary.totals.reasoningTokensAvailable) }} reasoning tokens.
                </p>
              </section>
              <section v-else aria-labelledby="usage-token-types-heading" class="flex flex-col gap-3">
                <h2 id="usage-token-types-heading" class="text-sm font-semibold">Tokens by type</h2>
                <dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
                  <div v-for="stat in tokenTypeStats" :key="stat.label">
                    <dt class="text-xs text-muted">{{ stat.label }}</dt>
                    <dd class="mt-1 font-semibold tabular-nums">{{ formatTokenEvidence(stat.value, stat.available) }}</dd>
                    <dd v-if="stat.note" class="mt-0.5 text-xs text-muted">{{ stat.note }}</dd>
                  </div>
                </dl>
              </section>

              <section class="flex flex-col gap-3">
                <div class="flex items-center justify-between gap-3">
                  <h2 class="text-sm font-semibold">Breakdown</h2>
                  <div class="flex gap-1" role="group" aria-label="Usage breakdown">
                    <UButton
                      v-for="option in breakdownOptions"
                      :key="option.value"
                      :label="option.label"
                      color="neutral"
                      size="xs"
                      :variant="breakdown === option.value ? 'soft' : 'ghost'"
                      :aria-pressed="breakdown === option.value"
                      @click="breakdown = option.value"
                    />
                  </div>
                </div>
                <div class="overflow-x-auto rounded-md border border-default">
                  <table v-if="breakdown === 'model' && summary.models.length" class="w-full min-w-xl text-xs" data-slot="usage-model-breakdown">
                    <thead class="bg-elevated/30 text-left text-muted">
                      <tr>
                        <th class="h-9 w-10 pr-2 pl-3 font-medium" scope="col">#</th>
                        <th class="h-9 pr-3 font-medium" scope="col">Model</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Sessions</th>
                        <th v-if="costSupported" class="h-9 px-3 text-right font-medium" scope="col">Cost</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Share</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(model, index) in breakdownModels"
                        :key="model.model"
                        class="relative border-t border-default transition-colors hover:bg-elevated/50 has-focus-visible:bg-elevated/50"
                      >
                        <td class="py-2.5 pr-2 pl-3 text-muted tabular-nums">{{ index + 1 }}</td>
                        <td class="py-2.5 pr-3">
                          <!-- The button overlay makes the whole row open the model. Focus shows as the row fill. -->
                          <button
                            type="button"
                            class="text-left font-medium text-highlighted outline-none after:absolute after:inset-0"
                            :aria-label="`${model.model} usage details`"
                            @click="selectedModelName = model.model"
                          >
                            {{ model.model }}
                          </button>
                          <div aria-hidden="true" class="mt-1.5 h-0.5 max-w-48">
                            <div class="h-full rounded-full bg-primary" :style="{ width: modelBarWidth(model) }" />
                          </div>
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-muted">{{ formatTokenEvidence(model.invocations, model.invocationsAvailable) }}</td>
                        <td v-if="costSupported" class="px-3 py-2.5 text-right tabular-nums" :class="model.pricedInvocations ? '' : 'text-muted'">{{ formatCostEvidence(model.costUsd, model.costEstimated, model.costAvailable) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-muted">{{ modelShare(model) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ formatTokenEvidence(model.totalTokens, model.totalTokensAvailable) }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <table v-else-if="breakdown === 'time' && summary.buckets.length" class="w-full min-w-xl text-xs">
                    <thead class="bg-elevated/30 text-left text-muted">
                      <tr>
                        <th class="h-9 px-3 font-medium" scope="col">{{ summary.resolution === "hour" ? "Hour (UTC)" : "Day (UTC)" }}</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Sessions</th>
                        <th v-if="costSupported" class="h-9 px-3 text-right font-medium" scope="col">Cost</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="bucket in breakdownBuckets" :key="bucket.start" class="border-t border-default">
                        <td class="px-3 py-2.5 font-medium">{{ formatPeriod(bucket.start, summary.resolution) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-muted">{{ formatTokenEvidence(bucket.invocations, bucket.invocationsAvailable) }}</td>
                        <td v-if="costSupported" class="px-3 py-2.5 text-right tabular-nums">{{ formatCostEvidence(bucket.costUsd, bucket.costEstimated, bucket.costAvailable) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ formatTokenEvidence(bucket.totalTokens, bucket.totalTokensAvailable) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section v-if="costSupported && summary.totals.pricedInvocations" class="flex flex-col gap-3">
                <div>
                  <h2 class="text-sm font-semibold">Average cost per session</h2>
                  <p class="mt-0.5 text-xs text-muted">
                    {{ summary.totals.pricedInvocations }} of {{ summary.totals.invocations }} sessions have
                    cost evidence. Averages use priced sessions. ~ indicates estimated cost.
                  </p>
                </div>
                <div class="overflow-x-auto rounded-md border border-default">
                  <table class="w-full min-w-lg text-xs">
                    <thead class="bg-elevated/30 text-left text-muted">
                      <tr>
                        <th class="h-9 px-3 font-medium" scope="col">Agent or model</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Priced sessions</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Average</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Recorded cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in averageRows" :key="item.key" class="border-t border-default">
                        <td class="px-3 py-2.5"><span class="font-medium text-highlighted">{{ item.label }}</span> <span class="text-muted">{{ item.kind }}</span></td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-muted">{{ item.pricedInvocations }} / {{ item.invocations }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ item.averageCostUsd === undefined ? "Unavailable" : formatCost(item.averageCostUsd, item.costEstimated) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ item.pricedInvocations ? formatCost(item.costUsd, item.costEstimated) : "Unavailable" }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section v-if="costSupported && summary.expensive.length" class="flex flex-col gap-3">
                <div class="flex items-baseline justify-between gap-3">
                  <h2 class="text-sm font-semibold">Most expensive sessions</h2>
                  <span class="text-xs text-muted">Top 10 with cost evidence</span>
                </div>
                <div class="overflow-x-auto rounded-md border border-default">
                  <table class="w-full min-w-xl text-xs">
                    <thead class="bg-elevated/30 text-left text-muted">
                      <tr>
                        <th class="h-9 px-3 font-medium" scope="col">Session</th>
                        <th class="h-9 px-3 font-medium" scope="col">Agent / model</th>
                        <th class="h-9 px-3 font-medium" scope="col">Status</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Tokens</th>
                        <th class="h-9 px-3 text-right font-medium" scope="col">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="run in summary.expensive" :key="run.id" class="border-t border-default">
                        <td class="px-3 py-2.5">
                          <RouterLink v-if="runRoute(run)" :to="runRoute(run)!" class="font-medium text-highlighted underline-offset-4 hover:underline" :title="run.id">{{ run.id.length > 24 ? `${run.id.slice(0, 20)}…` : run.id }}</RouterLink>
                          <span v-else class="font-medium" :title="run.id">{{ run.id.length > 24 ? `${run.id.slice(0, 20)}…` : run.id }}</span>
                          <p class="mt-0.5 text-muted"><time :datetime="run.at" :title="formatDateTime(run.at)">{{ formatTimestamp(run.at) }}</time></p>
                        </td>
                        <td class="px-3 py-2.5">
                          {{ run.agent }}
                          <p class="mt-0.5 text-muted">{{ run.usage?.model || "Model unavailable" }}</p>
                        </td>
                        <td class="px-3 py-2.5 text-muted capitalize">{{ run.status }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ run.usage?.totalTokens === undefined ? "Unavailable" : formatTokens(run.usage.totalTokens) }}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{{ run.usage?.cost ? formatCost(run.usage.cost.usd, run.usage.cost.estimated) : "Unavailable" }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </template>
          <template #sessions>
            <section v-if="summary" aria-labelledby="session-history-heading">
              <div class="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="session-history-heading" ref="historyHeading" class="scroll-mt-4 text-sm font-semibold outline-none" tabindex="-1">Session history</h2>
                <span class="text-xs text-muted">Newest first</span>
              </div>
              <div v-if="summary.sessions.length" class="overflow-x-auto rounded-md border border-default">
                <table class="w-full min-w-[42rem] table-fixed text-xs" data-slot="session-history">
                  <thead class="bg-elevated/30 text-left text-muted">
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
          <template #accounts>
            <section aria-labelledby="usage-accounts-heading">
              <h2 id="usage-accounts-heading" class="text-sm font-semibold">Provider accounts</h2>
              <p class="mt-0.5 mb-3 text-xs text-muted">Provider limits apply to the shared account or credential. Recorded session tokens and API cost estimates are shown separately.</p>

              <p v-if="statusError" class="flex items-start gap-2 p-3 text-sm" role="status">
                <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                {{ statusError }}
              </p>
              <div v-else class="grid gap-3 lg:grid-cols-2">
                <article
                  v-for="status in accounts"
                  :key="status.account?.id || status.agent"
                  class="space-y-3 rounded-md border border-default p-4"
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
        </UTabs>
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
    </template>
  </UDashboardPanel>
</template>
