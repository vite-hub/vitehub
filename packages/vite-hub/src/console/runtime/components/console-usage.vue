<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import * as v from "valibot"

import { requestConsole } from "../client/request"

type UsageMetric = "cost" | "tokens"
type UsageBreakdown = "model" | "time"
type UsageWindow = "24h" | "7d" | "30d" | "90d"
const usageTotalsEntries = {
  cacheWriteTokens: v.number(),
  cacheWriteTokensAvailable: v.boolean(),
  cachedInputTokens: v.number(),
  cachedInputTokensAvailable: v.boolean(),
  costAvailable: v.boolean(),
  costEstimated: v.boolean(),
  costUsd: v.string(),
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
}
const usageTotalsSchema = v.object(usageTotalsEntries)
const usageModelSchema = v.object({ ...usageTotalsEntries, model: v.string() })
const usageBucketSchema = v.object({
  ...usageTotalsEntries,
  models: v.array(usageModelSchema),
  start: v.string(),
})
const usageSummarySchema = v.object({
  available: v.boolean(),
  buckets: v.array(usageBucketSchema),
  costAvailable: v.boolean(),
  from: v.string(),
  generatedAt: v.string(),
  models: v.array(usageModelSchema),
  partial: v.boolean(),
  resolution: v.picklist(["day", "hour"]),
  to: v.string(),
  totals: usageTotalsSchema,
})
type UsageTotals = v.InferOutput<typeof usageTotalsSchema>
type UsageSummary = v.InferOutput<typeof usageSummarySchema>

const props = defineProps<{ base: string }>()
const emit = defineEmits<{ openSessions: [] }>()
const window = ref<UsageWindow>("30d")
const metric = ref<UsageMetric>("cost")
const breakdown = ref<UsageBreakdown>("model")
const summary = ref<UsageSummary>()
const loading = ref(true)
const error = ref<unknown>()
let request: AbortController | undefined

const windowOptions: Array<{ label: string, value: UsageWindow }> = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
]
const metricOptions: Array<{ label: string, value: UsageMetric }> = [
  { label: "Cost", value: "cost" },
  { label: "Tokens", value: "tokens" },
]
const breakdownOptions = computed<Array<{ label: string, value: UsageBreakdown }>>(() => [
  { label: "Model", value: "model" },
  { label: summary.value?.resolution === "hour" ? "Hour" : "Day", value: "time" },
])
const metricComplete = (totals: UsageTotals): boolean => metric.value === "cost"
  ? totals.costAvailable
  : totals.totalTokensAvailable
const value = (totals: UsageTotals): number => metric.value === "cost"
  ? Number(totals.costUsd) || 0
  : totals.totalTokens
const chartWidth = 1_000
const chartHeight = 220
const chartTickCount = 4
const chartMaximum = computed(() => niceMaximum(Math.max(0, ...(summary.value?.buckets.map(value) ?? []))))
const chartTicks = computed(() => Array.from(
  { length: chartTickCount + 1 },
  (_, index) => chartMaximum.value / chartTickCount * index,
))
const chartBuckets = computed(() => {
  const buckets = summary.value?.buckets ?? []
  return buckets.map((bucket, index) => ({
    ...bucket,
    recorded: value(bucket),
    x: buckets.length === 1 ? chartWidth / 2 : index / (buckets.length - 1) * chartWidth,
    y: chartY(value(bucket)),
  }))
})
const chartLine = computed(() => chartBuckets.value
  .map((bucket, index) => `${index ? "L" : "M"}${bucket.x.toFixed(2)},${bucket.y.toFixed(2)}`)
  .join(" "))
const chartArea = computed(() => chartLine.value
  ? `${chartLine.value} L${chartWidth},${chartHeight} L0,${chartHeight} Z`
  : "")
const chartHasActivity = computed(() => chartBuckets.value.some(bucket => bucket.recorded > 0))
const partialChartBuckets = computed(() => chartBuckets.value.filter(bucket =>
  !metricComplete(bucket) && bucket.recorded > 0,
))
const breakdownBuckets = computed(() => (summary.value?.buckets ?? [])
  .filter(bucket => bucket.invocations > 0 || bucket.totalTokens > 0 || (Number(bucket.costUsd) || 0) > 0)
  .toReversed())
const breakdownModels = computed(() => [...(summary.value?.models ?? [])].sort((left, right) =>
  metric.value === "cost"
    ? (Number(right.costUsd) || 0) - (Number(left.costUsd) || 0) || right.totalTokens - left.totalTokens
    : right.totalTokens - left.totalTokens || (Number(right.costUsd) || 0) - (Number(left.costUsd) || 0),
))

function niceMaximum(peak: number): number {
  if (peak <= 0) return 0
  const roughStep = peak / chartTickCount
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalized = roughStep / magnitude
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude
  return Math.ceil(peak / step) * step
}

function chartY(recorded: number): number {
  return chartMaximum.value === 0 ? chartHeight : chartHeight - recorded / chartMaximum.value * chartHeight
}

function chartTickPosition(tick: number): string {
  return `${chartMaximum.value === 0 ? 100 : 100 - tick / chartMaximum.value * 100}%`
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value)
}

function formatCost(value: string, estimated = false): string {
  const resolved = Number(value) || 0
  if (resolved > 0 && resolved < 0.01 && /^0\.\d+$/.test(value)) {
    return `${estimated ? "~" : ""}$${value}`
  }
  const display = new Intl.NumberFormat("en", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(resolved)
  return estimated ? `~${display}` : display
}

function formatValue(totals: UsageTotals): string {
  const recorded = value(totals)
  if (!metricComplete(totals) && recorded === 0) return "Unavailable"
  const display = metric.value === "cost"
    ? formatCost(totals.costUsd, totals.costEstimated)
    : formatTokens(totals.totalTokens)
  return metricComplete(totals) ? display : `${display} recorded`
}

function formatMetricNumber(value: number): string {
  return metric.value === "cost" ? formatCost(String(value)) : formatTokens(value)
}

function formatTokenEvidence(value: number, complete: boolean): string {
  if (!complete && value === 0) return "—"
  const display = formatTokens(value)
  return complete ? display : `${display} recorded`
}

function formatCostEvidence(value: string, estimated: boolean, complete: boolean): string {
  if (!complete && (Number(value) || 0) === 0) return "—"
  const display = formatCost(value, estimated)
  return complete ? display : `${display} recorded`
}

function formatShare(value: string, total: string): string {
  const denominator = Number(total) || 0
  return denominator > 0 ? `${((Number(value) || 0) / denominator * 100).toFixed(1)}%` : "—"
}

function formatPeriod(value: string, resolution: "day" | "hour"): string {
  return new Intl.DateTimeFormat("en", resolution === "hour"
    ? { day: "numeric", hour: "numeric", month: "short" }
    : { day: "numeric", month: "short" }).format(new Date(value))
}

function errorMessage(value: unknown): string | undefined {
  return value instanceof Error ? value.message : value ? "Usage could not be loaded." : undefined
}

async function load(): Promise<void> {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  summary.value = undefined
  error.value = undefined
  try {
    const result = v.parse(usageSummarySchema, await requestConsole(props.base, {
      query: { window: window.value },
      signal: controller.signal,
    }))
    if (request !== controller) return
    summary.value = result
    error.value = undefined
    if (!result.costAvailable && (Number(result.totals.costUsd) || 0) === 0) metric.value = "tokens"
  }
  catch (value) {
    if (value instanceof Object && "name" in value && value.name === "AbortError") return
    if (request === controller) error.value = value
  }
  finally {
    if (request === controller) {
      request = undefined
      loading.value = false
    }
  }
}

watch(window, () => void load(), { immediate: true })
onBeforeUnmount(() => request?.abort())
</script>

<template>
  <UDashboardPanel id="console-usage" :ui="{ body: 'min-h-0 overflow-y-auto p-0 gap-0' }">
    <template #header>
      <UDashboardNavbar title="Usage" :ui="{ root: 'border-b border-default' }">
        <template #right>
          <UTooltip text="Open sessions">
            <UButton
              class="lg:hidden"
              icon="i-ph-sidebar-simple-light"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Open sessions"
              @click="emit('openSessions')"
            />
          </UTooltip>
          <div
            v-if="summary"
            class="hidden rounded-md bg-elevated p-0.5 sm:inline-flex"
            aria-label="Usage metric"
          >
            <UButton
              v-for="option in metricOptions"
              :key="option.value"
              :label="option.label"
              color="neutral"
              size="xs"
              :variant="metric === option.value ? 'solid' : 'ghost'"
              @click="metric = option.value"
            />
          </div>
          <USelect
            v-model="window"
            aria-label="Usage period"
            class="w-24 sm:w-28"
            size="sm"
            value-key="value"
            :items="windowOptions"
          />
          <UTooltip text="Refresh usage">
            <UButton
              class="hidden sm:inline-flex"
              aria-label="Refresh usage"
              color="neutral"
              icon="i-ph-arrows-clockwise-light"
              size="sm"
              variant="ghost"
              :loading="loading"
              @click="load"
            />
          </UTooltip>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <main class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:py-10">
        <div
          v-if="summary"
          class="inline-flex self-start rounded-md bg-elevated p-0.5 sm:hidden"
          aria-label="Usage metric"
        >
          <UButton
            v-for="option in metricOptions"
            :key="option.value"
            :label="option.label"
            color="neutral"
            size="xs"
            :variant="metric === option.value ? 'solid' : 'ghost'"
            @click="metric = option.value"
          />
        </div>
        <UAlert
          v-if="errorMessage(error)"
          color="error"
          variant="subtle"
          icon="i-ph-cloud-slash-light"
          title="Could not load usage"
          :description="errorMessage(error)"
          :actions="[{ label: 'Try again', icon: 'i-ph-arrows-clockwise-light', onClick: load }]"
        />
        <UAlert
          v-if="summary?.partial"
          color="warning"
          variant="subtle"
          icon="i-ph-warning-light"
          title="Partial usage"
          description="Some usage evidence is unavailable for this period. Values labeled recorded exclude missing usage."
        />

        <template v-if="loading && !summary">
          <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <USkeleton v-for="index in 4" :key="index" class="h-28 rounded-lg" />
          </section>
          <USkeleton class="h-72 rounded-lg" />
        </template>

        <UEmpty
          v-else-if="!error && !summary?.available"
          class="min-h-96"
          icon="i-ph-chart-bar-light"
          title="No usage recorded yet"
          description="Provider-reported usage appears here after an Agent Invocation completes."
        />

        <template v-else-if="summary">
          <section class="overflow-hidden rounded-lg border border-default bg-elevated/20">
            <div class="grid lg:grid-cols-[17rem_minmax(0,1fr)]">
              <div class="flex flex-col justify-between gap-8 border-b border-default p-5 lg:border-r lg:border-b-0 sm:p-6">
                <div>
                  <p class="text-xs font-medium text-muted">
                    Total {{ metric === "cost" ? "cost" : "processed tokens" }}
                  </p>
                  <p class="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
                    {{ formatValue(summary.totals) }}
                  </p>
                  <p class="mt-2 text-xs text-muted">
                    {{ formatPeriod(summary.from, summary.resolution) }} to {{ formatPeriod(summary.to, summary.resolution) }}
                  </p>
                </div>
                <dl class="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <dt class="text-muted">Sessions</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{ formatTokenEvidence(summary.totals.invocations, summary.totals.invocationsAvailable) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">Total cost</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{ formatCostEvidence(summary.totals.costUsd, summary.totals.costEstimated, summary.totals.costAvailable) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">Processed</dt>
                    <dd class="mt-1 font-medium tabular-nums">
                      {{ formatTokenEvidence(summary.totals.totalTokens, summary.totals.totalTokensAvailable) }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-muted">Resolution</dt>
                    <dd class="mt-1 font-medium">{{ summary.resolution === "hour" ? "Hourly" : "Daily" }}</dd>
                  </div>
                </dl>
              </div>

              <div class="min-w-0 p-5 sm:p-6">
                <div class="flex items-baseline justify-between gap-4">
                  <h2 class="text-sm font-semibold">
                    {{ summary.resolution === "hour" ? "Hourly" : "Daily" }} {{ metric === "cost" ? "cost" : "tokens" }}
                  </h2>
                  <p v-if="partialChartBuckets.length" class="inline-flex items-center gap-1.5 text-xs text-warning">
                    <span class="size-1.5 rounded-full bg-warning" /> Partial points
                  </p>
                </div>
                <div class="relative mt-6 h-64 pl-14 pb-6" aria-label="Usage over time">
                  <div class="absolute inset-y-6 left-0 w-12 text-right text-[10px] tabular-nums text-muted">
                    <span
                      v-for="tick in chartTicks"
                      :key="tick"
                      class="absolute right-0 -translate-y-1/2"
                      :style="{ top: chartTickPosition(tick) }"
                    >{{ formatMetricNumber(tick) }}</span>
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
                      <path v-if="chartHasActivity" :d="chartArea" fill="url(#usage-area)" class="text-primary" />
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
                    >No recorded {{ metric }} for this period</p>
                    <div
                      class="absolute inset-0 grid"
                      :style="{ gridTemplateColumns: `repeat(${Math.max(chartBuckets.length, 1)}, minmax(0, 1fr))` }"
                    >
                      <UTooltip
                        v-for="bucket in chartBuckets"
                        :key="bucket.start"
                        :text="`${formatPeriod(bucket.start, summary.resolution)}: ${formatValue(bucket)}`"
                      >
                        <button class="h-full w-full cursor-crosshair" :aria-label="`${formatPeriod(bucket.start, summary.resolution)}: ${formatValue(bucket)}`" />
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
            <dl class="grid overflow-hidden rounded-lg border border-default sm:grid-cols-2 lg:grid-cols-4">
              <div class="border-b border-default p-4 sm:border-r">
                <dt class="text-xs text-muted">Total cost</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatCostEvidence(summary.totals.costUsd, summary.totals.costEstimated, summary.totals.costAvailable) }}
                </dd>
              </div>
              <div class="border-b border-default p-4 lg:border-r">
                <dt class="text-xs text-muted">Processed tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.totalTokens, summary.totals.totalTokensAvailable) }}
                </dd>
              </div>
              <div class="border-b border-r border-default p-4 sm:border-r lg:border-r">
                <dt class="text-xs text-muted">Sessions</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.invocations, summary.totals.invocationsAvailable) }}
                </dd>
              </div>
              <div class="border-b border-default p-4">
                <dt class="text-xs text-muted">Input tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.inputTokens, summary.totals.inputTokensAvailable) }}
                </dd>
              </div>
              <div class="border-b border-default p-4 sm:border-r sm:border-b-0 lg:border-r">
                <dt class="text-xs text-muted">Cached input</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.cachedInputTokens, summary.totals.cachedInputTokensAvailable) }}
                </dd>
              </div>
              <div class="border-b border-default p-4 sm:border-b-0 lg:border-r">
                <dt class="text-xs text-muted">Cache writes</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.cacheWriteTokens, summary.totals.cacheWriteTokensAvailable) }}
                </dd>
              </div>
              <div class="border-b border-r border-default p-4 sm:border-b-0">
                <dt class="text-xs text-muted">Output tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.outputTokens, summary.totals.outputTokensAvailable) }}
                </dd>
              </div>
              <div class="p-4">
                <dt class="text-xs text-muted">Reasoning tokens</dt>
                <dd class="mt-1.5 font-semibold tabular-nums">
                  {{ formatTokenEvidence(summary.totals.reasoningTokens, summary.totals.reasoningTokensAvailable) }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="overflow-hidden rounded-lg border border-default">
            <div class="flex items-center justify-between gap-4 border-b border-default px-4 py-3 sm:px-5">
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
                    <th class="px-4 py-3 text-right font-medium">Calls</th>
                    <th class="px-4 py-3 text-right font-medium">Cost</th>
                    <th class="px-4 py-3 text-right font-medium">Share</th>
                    <th class="px-4 py-3 text-right font-medium sm:px-5">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="model in breakdownModels" :key="model.model" class="border-t border-default">
                    <td class="px-4 py-3 font-medium sm:px-5">{{ model.model }}</td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ formatTokenEvidence(model.invocations, model.invocationsAvailable) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums">
                      {{ formatCostEvidence(model.costUsd, model.costEstimated, model.costAvailable) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
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
                    <th class="px-4 py-3 font-medium sm:px-5">{{ summary.resolution === "hour" ? "Hour" : "Day" }}</th>
                    <th class="px-4 py-3 text-right font-medium">Sessions</th>
                    <th class="px-4 py-3 text-right font-medium">Cost</th>
                    <th class="px-4 py-3 text-right font-medium sm:px-5">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="bucket in breakdownBuckets" :key="bucket.start" class="border-t border-default">
                    <td class="px-4 py-3 font-medium sm:px-5">{{ formatPeriod(bucket.start, summary.resolution) }}</td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">
                      {{ formatTokenEvidence(bucket.invocations, bucket.invocationsAvailable) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums">
                      {{ formatCostEvidence(bucket.costUsd, bucket.costEstimated, bucket.costAvailable) }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums sm:px-5">
                      {{ formatTokenEvidence(bucket.totalTokens, bucket.totalTokensAvailable) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
      </main>
    </template>
  </UDashboardPanel>
</template>
