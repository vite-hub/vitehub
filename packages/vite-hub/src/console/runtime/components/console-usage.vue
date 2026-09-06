<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import * as v from "valibot";

import { useRoute, useRouter } from "vue-router";
import { encodeAgentRouteParam, resolveConsoleRouteName } from "../console-route";
import { requestConsole } from "../client/request";

type UsageMetric = "cost" | "tokens";
type UsageBreakdown = "model" | "time";
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
      readiness: v.picklist(["ready", "unavailable", "unknown", "unsupported"]),
      checkedAt: v.string(),
      stale: v.boolean(),
      reason: v.optional(v.string()),
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
const emit = defineEmits<{ openSessions: [] }>();
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
const metric = ref<UsageMetric>("cost");
const breakdown = ref<UsageBreakdown>("model");
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
const statusError = ref<string>();
const runCursor = ref<string>();
const previousCursors = ref<Array<string | undefined>>([]);
const costSupported = computed(() => summary.value?.costSupported === true);
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

function nextRuns() {
  if (loading.value || !summary.value?.cursor) return;
  void loadPage({ cursor: summary.value.cursor, previous: [...previousCursors.value, runCursor.value] });
}
function previousRuns() {
  if (loading.value || !previousCursors.value.length) return;
  void loadPage({ cursor: previousCursors.value.at(-1), previous: previousCursors.value.slice(0, -1) });
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
const metricComplete = (totals: UsageTotals): boolean =>
  metric.value === "cost" ? totals.costAvailable : totals.totalTokensAvailable;
const value = (totals: UsageTotals): number =>
  metric.value === "cost" ? Number(totals.costUsd) || 0 : totals.totalTokens;
const chartWidth = 1_000;
const chartHeight = 220;
const chartTickCount = 4;
const chartMaximum = computed(() =>
  niceMaximum(Math.max(0, ...(summary.value?.buckets.map(value) ?? []))),
);
const chartTicks = computed(() =>
  Array.from(
    { length: chartTickCount + 1 },
    (_, index) => (chartMaximum.value / chartTickCount) * index,
  ),
);
const chartBuckets = computed(() => {
  const buckets = summary.value?.buckets ?? [];
  return buckets.map((bucket, index) => ({
    ...bucket,
    recorded: value(bucket),
    x: buckets.length === 1 ? chartWidth / 2 : (index / (buckets.length - 1)) * chartWidth,
    y: chartY(value(bucket)),
  }));
});
const chartLine = computed(() =>
  chartBuckets.value
    .map((bucket, index) => `${index ? "L" : "M"}${bucket.x.toFixed(2)},${bucket.y.toFixed(2)}`)
    .join(" "),
);
const chartArea = computed(() =>
  chartLine.value ? `${chartLine.value} L${chartWidth},${chartHeight} L0,${chartHeight} Z` : "",
);
const chartHasActivity = computed(() => chartBuckets.value.some((bucket) => bucket.recorded > 0));
const partialChartBuckets = computed(() =>
  chartBuckets.value.filter((bucket) => !metricComplete(bucket) && bucket.recorded > 0),
);
const breakdownBuckets = computed(() =>
  (summary.value?.buckets ?? [])
    .filter(
      (bucket) =>
        bucket.invocations > 0 || bucket.totalTokens > 0 || (Number(bucket.costUsd) || 0) > 0,
    )
    .toReversed(),
);
const breakdownModels = computed(() =>
  [...(summary.value?.models ?? [])].sort((left, right) =>
    metric.value === "cost"
      ? (Number(right.costUsd) || 0) - (Number(left.costUsd) || 0) ||
        right.totalTokens - left.totalTokens
      : right.totalTokens - left.totalTokens ||
        (Number(right.costUsd) || 0) - (Number(left.costUsd) || 0),
  ),
);

function niceMaximum(peak: number): number {
  if (peak <= 0) return 0;
  const roughStep = peak / chartTickCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

function chartY(recorded: number): number {
  return chartMaximum.value === 0
    ? chartHeight
    : chartHeight - (recorded / chartMaximum.value) * chartHeight;
}

function chartTickPosition(tick: number): string {
  return `${chartMaximum.value === 0 ? 100 : 100 - (tick / chartMaximum.value) * 100}%`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function formatCost(value: string, estimated = false): string {
  const resolved = Number(value) || 0;
  if (resolved > 0 && resolved < 0.01 && /^0\.\d+$/.test(value)) {
    return `${estimated ? "~" : ""}$${value}`;
  }
  const display = new Intl.NumberFormat("en", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(resolved);
  return estimated ? `~${display}` : display;
}

function formatValue(totals: UsageTotals): string {
  const recorded = value(totals);
  if (!metricComplete(totals) && recorded === 0) return "Unavailable";
  const display =
    metric.value === "cost"
      ? formatCost(totals.costUsd, totals.costEstimated)
      : formatTokens(totals.totalTokens);
  return metricComplete(totals) ? display : `${display} recorded`;
}

function formatMetricNumber(value: number): string {
  return metric.value === "cost" ? formatCost(String(value)) : formatTokens(value);
}

function formatTokenEvidence(value: number, complete: boolean): string {
  if (!complete && value === 0) return "Unavailable";
  const display = formatTokens(value);
  return complete ? display : `${display} recorded`;
}

function formatCostEvidence(value: string, estimated: boolean, complete: boolean): string {
  if (!complete && (Number(value) || 0) === 0) return "Unavailable";
  const display = formatCost(value, estimated);
  return complete ? display : `${display} recorded`;
}

function formatShare(value: string, total: string): string {
  const denominator = Number(total) || 0;
  return denominator > 0 ? `${(((Number(value) || 0) / denominator) * 100).toFixed(1)}%` : "—";
}

function formatPeriod(value: string, resolution: "day" | "hour"): string {
  return new Intl.DateTimeFormat(
    "en",
    resolution === "hour"
      ? { day: "numeric", hour: "numeric", month: "short" }
      : { day: "numeric", month: "short" },
  ).format(new Date(value));
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
    if (!result.costSupported) metric.value = "tokens";
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
  <UDashboardPanel id="console-usage" class="console-usage" :ui="{ body: 'min-h-0 overflow-y-auto p-0 gap-0' }">
    <template #header>
      <UDashboardNavbar title="Usage" :ui="{ root: 'border-b border-default' }">
        <template #right>
          <UButton class="md:hidden" icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" aria-label="Open sessions" @click="emit('openSessions')" />
          <USelect v-model="window" aria-label="Usage period" class="w-28" size="sm" value-key="value" :items="windowOptions" />
          <UButton aria-label="Refresh usage" color="neutral" icon="i-lucide-refresh-cw" size="sm" variant="ghost" :disabled="loading" @click="refresh(); loadStatus();" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <main class="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6" :aria-busy="loading">
        <div class="flex flex-wrap items-center gap-2" role="search" aria-label="Session history filters">
          <UInput v-model="searchInput" type="search" icon="i-lucide-search" placeholder="Search sessions" aria-label="Search session history" class="min-w-40 flex-1 sm:max-w-80" size="sm" />
          <USelect v-model="selectedAgent" :items="agentOptions" value-key="value" aria-label="Agent" size="sm" class="w-40 max-w-full" />
          <USelect v-model="status" :items="statusOptions" value-key="value" aria-label="Session status" size="sm" class="w-36" />
        </div>
        <UAlert v-if="errorMessage(error)" color="error" variant="subtle" title="Could not load session history" :description="errorMessage(error)" :actions="[{ label: 'Try again', onClick: load }]" />
        <p v-if="summary?.partial" class="flex items-start gap-2 text-xs text-muted" role="status">
          <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
          Some usage is unavailable. Recorded totals include only the evidence received.
        </p>
        <template v-if="summary">
          <dl class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" aria-label="Session history totals">
            <div><dt class="text-xs text-muted">Sessions</dt><dd class="mt-1 text-2xl font-semibold tabular-nums">{{ summary.sessionCount.toLocaleString('en') }}{{ summary.totals.invocationsAvailable ? '' : ' recorded' }}</dd></div>
            <div><dt class="text-xs text-muted">Tokens</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ formatTokenEvidence(summary.totals.totalTokens, summary.totals.totalTokensAvailable) }}</dd></div>
            <div v-if="costSupported"><dt class="text-xs text-muted">Cost</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ formatCostEvidence(summary.totals.costUsd, summary.totals.costEstimated, summary.totals.costAvailable) }}</dd></div>
            <div v-if="costSupported"><dt class="text-xs text-muted">Average per priced session</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ summary.totals.averageCostUsd === undefined ? 'Unavailable' : formatCost(summary.totals.averageCostUsd, summary.totals.costEstimated) }}</dd></div>
          </dl>
        </template>
        <p v-else-if="loading" class="py-5 text-sm text-muted" role="status">Loading session history...</p>
        <section v-if="summary" aria-labelledby="session-history-heading">
          <div class="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="session-history-heading" class="text-sm font-semibold">Session history</h2>
            <span class="text-xs text-muted">Newest first</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[42rem] table-fixed text-sm" data-slot="session-history">
              <thead class="border-b border-default text-left text-xs text-muted">
                <tr>
                  <th class="w-[34%] py-2 pr-4 font-medium" scope="col">Session</th>
                  <th class="w-[19%] py-2 pr-4 font-medium" scope="col">Agent / model</th>
                  <th class="w-[15%] py-2 pr-4 font-medium" scope="col">Last activity</th>
                  <th class="w-[13%] py-2 pr-4 font-medium" scope="col">Status</th>
                  <th class="py-2 pl-2 text-right font-medium" scope="col">Tokens</th>
                  <th v-if="costSupported" class="py-2 pl-4 text-right font-medium" scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="session in summary.sessions" :key="session.id" class="border-b border-default/50 hover:bg-elevated/40">
                  <td class="py-3 pr-4 align-top">
                    <RouterLink v-if="runRoute(session)" :to="runRoute(session)!" class="block truncate font-medium text-highlighted underline-offset-4 hover:underline focus-visible:underline" :title="session.title || session.id">{{ session.title || session.id }}</RouterLink>
                    <span v-else class="block truncate" :title="session.title || session.id">{{ session.title || session.id }}</span>
                  </td>
                  <td class="py-3 pr-4 align-top"><span class="block truncate" :title="session.agent">{{ session.agent || 'Unknown agent' }}</span><span class="block truncate text-xs text-muted" :title="session.models.join(', ')">{{ session.models.length ? session.models.join(', ') : 'Model unavailable' }}</span></td>
                  <td class="py-3 pr-4 align-top text-xs text-muted"><time :datetime="session.at" :title="new Date(session.at).toLocaleString()">{{ formatPeriod(session.at, 'hour') }}</time></td>
                  <td class="py-3 pr-4 align-top"><span class="inline-flex items-center gap-1.5 text-xs" :class="session.status === 'failed' ? 'text-error' : 'text-muted'"><UIcon :name="statusIcons[session.status]" class="size-3.5 shrink-0" />{{ statusLabels[session.status] }}</span></td>
                  <td class="py-3 pl-2 text-right align-top text-xs tabular-nums" :class="session.totals.totalTokensAvailable ? 'text-highlighted' : 'text-muted'">{{ formatTokenEvidence(session.totals.totalTokens, session.totals.totalTokensAvailable) }}</td>
                  <td v-if="costSupported" class="py-3 pl-4 text-right align-top text-xs font-medium tabular-nums" :class="session.totals.costAvailable ? 'text-highlighted' : 'text-muted'">{{ formatCostEvidence(session.totals.costUsd, session.totals.costEstimated, session.totals.costAvailable) }}</td>
                </tr>
                <tr v-if="!summary.sessions.length"><td :colspan="costSupported ? 6 : 5" class="py-12 text-center text-sm text-muted">{{ !summary.totals.invocationsAvailable ? 'Session history is still loading. Refresh to check progress.' : search || agent || status !== 'all' ? 'No sessions match these filters.' : 'No completed sessions in this period.' }}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
            <span>{{ summary.sessions.length ? `${previousCursors.length * 50 + 1}–${previousCursors.length * 50 + summary.sessions.length} of ${summary.sessionCount}` : `${summary.sessionCount} sessions` }}{{ summary.totals.invocationsAvailable ? '' : ' recorded' }}</span>
            <div class="flex gap-1">
              <UButton label="Previous" aria-label="Previous history page" color="neutral" variant="ghost" size="xs" :disabled="!previousCursors.length || loading" @click="previousRuns" />
              <UButton label="Next" aria-label="Next history page" color="neutral" variant="ghost" size="xs" :disabled="!summary.cursor || loading" @click="nextRuns" />
            </div>
          </div>
        </section>
        <details v-if="summary?.available" class="border-t border-default pt-4">
          <summary class="cursor-pointer text-sm font-medium">Usage breakdown</summary>
          <div class="mt-4 flex flex-col gap-6">
            <div class="flex gap-1" aria-label="Usage metric">
              <UButton v-for="option in metricOptions" :key="option.value" :label="option.label" color="neutral" size="xs" :variant="metric === option.value ? 'soft' : 'ghost'" :aria-pressed="metric === option.value" @click="metric = option.value" />
            </div>

          <section class="overflow-hidden">
            <div class="grid lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div
                class="flex flex-col justify-between gap-8 border-b border-default p-5 lg:border-r lg:border-b-0 sm:p-6"
              >
                <div>
                  <p class="text-xs font-medium text-muted">
                    Total {{ metric === "cost" ? "cost" : "processed tokens" }}
                  </p>
                  <p class="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
                    {{ formatValue(summary.totals) }}
                  </p>
                  <p class="mt-2 text-xs text-muted">
                    {{ formatPeriod(summary.from, summary.resolution) }} to
                    {{ formatPeriod(summary.to, summary.resolution) }}
                  </p>
                </div>
                <dl class="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <dt class="text-muted">Sessions</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{
                        formatTokenEvidence(
                          summary.totals.invocations,
                          summary.totals.invocationsAvailable,
                        )
                      }}
                    </dd>
                  </div>
                  <div v-if="costSupported">
                    <dt class="text-muted">Total cost</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{
                        formatCostEvidence(
                          summary.totals.costUsd,
                          summary.totals.costEstimated,
                          summary.totals.costAvailable,
                        )
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">Processed</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{
                        formatTokenEvidence(
                          summary.totals.totalTokens,
                          summary.totals.totalTokensAvailable,
                        )
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">Resolution</dt>
                    <dd class="mt-1 font-medium">
                      {{ summary.resolution === "hour" ? "Hourly" : "Daily" }}
                    </dd>
                  </div>
                </dl>
              </div>

              <div class="min-w-0 p-5 sm:p-6">
                <div class="flex items-baseline justify-between gap-4">
                  <h2 class="text-sm font-semibold">
                    {{ summary.resolution === "hour" ? "Hourly" : "Daily" }}
                    {{ metric === "cost" ? "cost" : "tokens" }}
                  </h2>
                  <p
                    v-if="partialChartBuckets.length"
                    class="inline-flex items-center gap-1.5 text-xs text-warning"
                  >
                    <span class="size-1.5 rounded-full bg-warning" /> Partial points
                  </p>
                </div>
                <div class="relative mt-6 h-64 pl-14 pb-6" aria-label="Usage over time">
                  <div
                    class="absolute inset-y-6 left-0 w-12 text-right text-[10px] tabular-nums text-muted"
                  >
                    <span
                      v-for="tick in chartTicks"
                      :key="tick"
                      class="absolute right-0 -translate-y-1/2"
                      :style="{ top: chartTickPosition(tick) }"
                      >{{ formatMetricNumber(tick) }}</span
                    >
                  </div>
                  <div class="relative h-full border-b border-default">
                    <svg
                      class="absolute inset-0 size-full overflow-visible"
                      :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
                      preserveAspectRatio="none"
                      role="img"
                    >
                      <defs>
                        <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="currentColor" stop-opacity="0.22" />
                          <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
                        </linearGradient>
                      </defs>
                      <line
                        v-for="tick in chartTicks"
                        :key="`grid-${tick}`"
                        x1="0"
                        :y1="chartY(tick)"
                        :x2="chartWidth"
                        :y2="chartY(tick)"
                        vector-effect="non-scaling-stroke"
                        class="stroke-default"
                        stroke-width="1"
                        stroke-dasharray="3 4"
                      />
                      <path
                        v-if="chartHasActivity"
                        :d="chartArea"
                        fill="url(#usage-area)"
                        class="text-primary"
                      />
                      <path
                        v-if="chartHasActivity"
                        :d="chartLine"
                        fill="none"
                        class="stroke-primary"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                      />
                      <circle
                        v-for="bucket in partialChartBuckets"
                        :key="`partial-${bucket.start}`"
                        :cx="bucket.x"
                        :cy="bucket.y"
                        r="4"
                        class="fill-warning stroke-default"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                      />
                    </svg>
                    <p
                      v-if="!chartHasActivity"
                      class="absolute inset-0 grid place-items-center text-xs text-muted"
                    >
                      No recorded {{ metric }} for this period
                    </p>
                    <div
                      class="absolute inset-0 grid"
                      :style="{
                        gridTemplateColumns: `repeat(${Math.max(chartBuckets.length, 1)}, minmax(0, 1fr))`,
                      }"
                    >
                      <UTooltip
                        v-for="bucket in chartBuckets"
                        :key="bucket.start"
                        :text="`${formatPeriod(bucket.start, summary.resolution)}: ${formatValue(bucket)}`"
                      >
                        <button
                          class="h-full w-full cursor-crosshair"
                          :aria-label="`${formatPeriod(bucket.start, summary.resolution)}: ${formatValue(bucket)}`"
                        />
                      </UTooltip>
                    </div>
                    <span class="absolute top-full left-0 mt-2 text-[10px] text-muted">
                      {{ formatPeriod(summary.from, summary.resolution) }}
                    </span>
                    <span class="absolute top-full right-0 mt-2 text-[10px] text-muted">
                      {{ formatPeriod(summary.to, summary.resolution) }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section>
            <div class="mb-3 flex items-baseline justify-between gap-4">
              <h2 class="text-sm font-semibold">Totals</h2>
              <p class="text-xs text-muted">Provider-reported evidence</p>
            </div>
            <dl
              class="grid overflow-hidden border-t border-default sm:grid-cols-2 lg:grid-cols-4"
            >
              <div v-if="costSupported" class="border-b border-default p-4 sm:border-r">
                <dt class="text-xs text-muted">Total cost</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatCostEvidence(
                      summary.totals.costUsd,
                      summary.totals.costEstimated,
                      summary.totals.costAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-default p-4 lg:border-r">
                <dt class="text-xs text-muted">Processed tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.totalTokens,
                      summary.totals.totalTokensAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-r border-default p-4 sm:border-r lg:border-r">
                <dt class="text-xs text-muted">Sessions</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.invocations,
                      summary.totals.invocationsAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-default p-4">
                <dt class="text-xs text-muted">Input tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.inputTokens,
                      summary.totals.inputTokensAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-default p-4 sm:border-r sm:border-b-0 lg:border-r">
                <dt class="text-xs text-muted">Cached input</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.cachedInputTokens,
                      summary.totals.cachedInputTokensAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-default p-4 sm:border-b-0 lg:border-r">
                <dt class="text-xs text-muted">Cache writes</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.cacheWriteTokens,
                      summary.totals.cacheWriteTokensAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="border-b border-r border-default p-4 sm:border-b-0">
                <dt class="text-xs text-muted">Output tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.outputTokens,
                      summary.totals.outputTokensAvailable,
                    )
                  }}
                </dd>
              </div>
              <div class="p-4">
                <dt class="text-xs text-muted">Reasoning tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{
                    formatTokenEvidence(
                      summary.totals.reasoningTokens,
                      summary.totals.reasoningTokensAvailable,
                    )
                  }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="overflow-hidden border-t border-default">
            <div
              class="flex items-center justify-between gap-4 border-b border-default px-4 py-3 sm:px-5"
            >
              <h2 class="text-sm font-semibold">Breakdown</h2>
              <div class="inline-flex rounded-md bg-elevated p-0.5" aria-label="Usage breakdown">
                <UButton
                  v-for="option in breakdownOptions"
                  :key="option.value"
                  :label="option.label"
                  color="neutral"
                  size="xs"
                  :variant="breakdown === option.value ? 'solid' : 'ghost'"
                  @click="breakdown = option.value"
                />
              </div>
            </div>
            <div class="overflow-x-auto">
              <table v-if="breakdown === 'model'" class="w-full min-w-2xl text-sm">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="px-4 py-3 font-medium sm:px-5">Model</th>
                    <th class="px-4 py-3 text-right font-medium">Runs</th>
                    <th v-if="costSupported" class="px-4 py-3 text-right font-medium">Cost</th>
                    <th v-if="costSupported" class="px-4 py-3 text-right font-medium">Share</th>
                    <th class="px-4 py-3 text-right font-medium sm:px-5">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="model in breakdownModels"
                    :key="model.model"
                    class="border-t border-default"
                  >
                    <td class="px-4 py-3 font-medium sm:px-5">{{ model.model }}</td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ formatTokenEvidence(model.invocations, model.invocationsAvailable) }}
                    </td>
                    <td v-if="costSupported" class="px-4 py-3 text-right tabular-nums">
                      {{
                        formatCostEvidence(model.costUsd, model.costEstimated, model.costAvailable)
                      }}
                    </td>
                    <td v-if="costSupported" class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ formatShare(model.costUsd, summary.totals.costUsd) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums sm:px-5">
                      {{ formatTokenEvidence(model.totalTokens, model.totalTokensAvailable) }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <table v-else class="w-full min-w-2xl text-sm">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="px-4 py-3 font-medium sm:px-5">
                      {{ summary.resolution === "hour" ? "Hour" : "Day" }}
                    </th>
                    <th class="px-4 py-3 text-right font-medium">Sessions</th>
                    <th v-if="costSupported" class="px-4 py-3 text-right font-medium">Cost</th>
                    <th class="px-4 py-3 text-right font-medium sm:px-5">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="bucket in breakdownBuckets"
                    :key="bucket.start"
                    class="border-t border-default"
                  >
                    <td class="px-4 py-3 font-medium sm:px-5">
                      {{ formatPeriod(bucket.start, summary.resolution) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ formatTokenEvidence(bucket.invocations, bucket.invocationsAvailable) }}
                    </td>
                    <td v-if="costSupported" class="px-4 py-3 text-right tabular-nums">
                      {{
                        formatCostEvidence(
                          bucket.costUsd,
                          bucket.costEstimated,
                          bucket.costAvailable,
                        )
                      }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums sm:px-5">
                      {{ formatTokenEvidence(bucket.totalTokens, bucket.totalTokensAvailable) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section v-if="costSupported" class="overflow-hidden border-t border-default">
            <div class="border-b border-default px-5 py-3">
              <h2 class="text-sm font-semibold">Average cost per run</h2>
              <p class="mt-1 text-xs text-muted">
                {{ summary.totals.pricedInvocations }} of {{ summary.totals.invocations }} runs have
                cost evidence. Averages use priced runs. ~ indicates estimated cost.
              </p>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full min-w-lg text-sm">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="px-5 py-3 font-medium">Agent / model</th>
                    <th class="px-5 py-3 text-right font-medium">Priced runs</th>
                    <th class="px-5 py-3 text-right font-medium">Average</th>
                    <th class="px-5 py-3 text-right font-medium">Recorded cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="item in [
                      ...summary.agents.map((row) => ({
                        ...row,
                        label: row.agent,
                        key: `agent:${row.agent}`,
                      })),
                      ...summary.models.map((row) => ({
                        ...row,
                        label: row.model,
                        key: `model:${row.model}`,
                      })),
                    ]"
                    :key="item.key"
                    class="border-t border-default"
                  >
                    <td class="px-5 py-3">{{ item.label }}</td>
                    <td class="px-5 py-3 text-right tabular-nums">
                      {{ item.pricedInvocations }} / {{ item.invocations }}
                    </td>
                    <td class="px-5 py-3 text-right tabular-nums">
                      {{
                        item.averageCostUsd === undefined
                          ? "Unavailable"
                          : formatCost(item.averageCostUsd, item.costEstimated)
                      }}
                    </td>
                    <td class="px-5 py-3 text-right tabular-nums">
                      {{
                        item.pricedInvocations
                          ? formatCost(item.costUsd, item.costEstimated)
                          : "Unavailable"
                      }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section
            v-for="table in [
              { key: 'expensive', title: 'Most expensive runs', rows: summary.expensive },
            ].filter((table) => table.key === 'runs' || costSupported)"
            :key="table.key"
            class="overflow-hidden border-t border-default"
          >
            <div class="flex items-center justify-between gap-3 border-b border-default px-5 py-3">
              <h2 class="text-sm font-semibold">{{ table.title }}</h2>
              <span class="text-xs text-muted">{{
                table.key === "expensive" ? "Top 10 with cost evidence" : "Newest first"
              }}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full min-w-2xl text-sm">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="px-5 py-3 font-medium">Run</th>
                    <th class="px-5 py-3 font-medium">Agent / model</th>
                    <th class="px-5 py-3 font-medium">Status</th>
                    <th class="px-5 py-3 text-right font-medium">Tokens</th>
                    <th v-if="costSupported" class="px-5 py-3 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in table.rows" :key="run.id" class="border-t border-default">
                    <td class="px-5 py-3">
                      <RouterLink
                        v-if="runRoute(run)"
                        :to="runRoute(run)!"
                        class="font-medium text-primary hover:underline"
                        >{{ run.id }}</RouterLink
                      >
                      <p class="mt-1 text-xs text-muted">{{ formatPeriod(run.at, "hour") }}</p>
                    </td>
                    <td class="px-5 py-3">
                      {{ run.agent }}
                      <p class="mt-1 text-xs text-muted">
                        {{ run.usage?.model || "Model unavailable" }}
                      </p>
                    </td>
                    <td class="px-5 py-3">
                      <UBadge color="neutral" variant="subtle">{{ run.status }}</UBadge>
                    </td>
                    <td class="px-5 py-3 text-right tabular-nums">
                      {{
                        run.usage?.totalTokens === undefined
                          ? "Unavailable"
                          : formatTokens(run.usage.totalTokens)
                      }}
                    </td>
                    <td v-if="costSupported" class="px-5 py-3 text-right tabular-nums">
                      {{
                        run.usage?.cost
                          ? formatCost(run.usage.cost.usd, run.usage.cost.estimated)
                          : "Unavailable"
                      }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

          </section>

          </div>
        </details>
        <details class="border-t border-default pt-4">
          <summary class="cursor-pointer text-sm font-medium">Provider status</summary>

          <p v-if="statusError" class="p-5 text-sm text-warning">{{ statusError }}</p>
          <div v-else class="grid divide-y divide-default lg:grid-cols-2 lg:divide-y-0">
            <article
              v-for="status in statuses.filter((item) => !agent || item.agent === agent)"
              :key="status.agent"
              class="space-y-3 p-5"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h3 class="text-sm font-medium">{{ status.agent }}</h3>
                  <p class="text-xs text-muted">{{ status.provider || "Provider" }}</p>
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
              <div class="flex flex-wrap gap-4 text-xs text-muted">
                <span v-if="status.authenticated !== undefined"
                  >Account: {{ status.authenticated ? "Signed in" : "Signed out" }}</span
                >
                <span>Checked {{ formatPeriod(status.checkedAt, "hour") }}</span>
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
                  Resets {{ formatPeriod(limit.resetsAt, "hour") }}
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
        </details>
      </main>
    </template>
  </UDashboardPanel>
</template>

<style scoped>
:global(.dark .console-usage) { background: #000; }
</style>
