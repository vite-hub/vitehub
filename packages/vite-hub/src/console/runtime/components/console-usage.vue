<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import * as v from "valibot"

import { requestConsole } from "../client/request"

type UsageMetric = "cost" | "tokens"
type UsageWindow = "24h" | "7d" | "30d" | "90d"
const usageTotalsEntries = {
  cacheWriteTokens: v.number(),
  cacheWriteTokensAvailable: v.boolean(),
  cachedInputTokens: v.number(),
  cachedInputTokensAvailable: v.boolean(),
  costAvailable: v.boolean(),
  costUsd: v.string(),
  inputTokens: v.number(),
  inputTokensAvailable: v.boolean(),
  invocations: v.number(),
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
const metricAvailable = (totals: UsageTotals): boolean => metric.value === "cost"
  ? totals.costAvailable
  : totals.totalTokensAvailable
const value = (totals: UsageTotals): number => metricAvailable(totals)
  ? metric.value === "cost" ? Number(totals.costUsd) || 0 : totals.totalTokens
  : 0
const chartMaximum = computed(() => Math.max(0, ...(summary.value?.buckets.map(value) ?? [])))
const chartBuckets = computed(() => (summary.value?.buckets ?? []).map(bucket => ({
  ...bucket,
  height: chartMaximum.value ? Math.max(2, value(bucket) / chartMaximum.value * 100) : 0,
})))

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value)
}

function formatCost(value: string | number): string {
  const resolved = Number(value) || 0
  if (typeof value === "string" && resolved > 0 && resolved < 0.01 && /^0\.\d+$/.test(value)) {
    return `$${value}`
  }
  return new Intl.NumberFormat("en", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(resolved)
}

function formatValue(totals: UsageTotals): string {
  if (!metricAvailable(totals)) return "Unavailable"
  return metric.value === "cost" ? formatCost(totals.costUsd) : formatTokens(totals.totalTokens)
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
    if (!result.costAvailable) metric.value = "tokens"
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
              icon="i-lucide-panel-left"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Open sessions"
              @click="emit('openSessions')"
            />
          </UTooltip>
          <div
            v-if="summary?.costAvailable"
            class="inline-flex rounded-md bg-elevated p-0.5"
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
            class="w-28"
            size="sm"
            value-key="value"
            :items="windowOptions"
          />
          <UTooltip text="Refresh usage">
            <UButton
              aria-label="Refresh usage"
              color="neutral"
              icon="i-lucide-refresh-cw"
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
        <UAlert
          v-if="errorMessage(error)"
          color="error"
          variant="subtle"
          icon="i-lucide-cloud-off"
          title="Could not load usage"
          :description="errorMessage(error)"
          :actions="[{ label: 'Try again', icon: 'i-lucide-refresh-cw', onClick: load }]"
        />
        <UAlert
          v-if="summary?.partial"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Partial usage"
          description="The journal scan reached 10,000 records. Totals cover the newest records in this period."
        />

        <template v-if="loading && !summary">
          <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <USkeleton v-for="index in 4" :key="index" class="h-28 rounded-lg" />
          </section>
          <USkeleton class="h-72 rounded-lg" />
        </template>

        <UEmpty
          v-else-if="!summary?.available"
          class="min-h-96"
          icon="i-lucide-chart-no-axes-column"
          title="No usage recorded yet"
          description="Provider-reported usage appears here after an Agent Invocation completes."
        />

        <template v-else-if="summary">
          <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="rounded-lg border border-default bg-elevated/30 p-4">
              <p class="text-xs text-muted">{{ metric === "cost" ? "API cost" : "Processed tokens" }}</p>
              <p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {{ formatValue(summary.totals) }}
              </p>
            </div>
            <div class="rounded-lg border border-default bg-elevated/30 p-4">
              <p class="text-xs text-muted">Sessions</p>
              <p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {{ formatTokens(summary.totals.invocations) }}
              </p>
            </div>
            <div class="rounded-lg border border-default bg-elevated/30 p-4">
              <p class="text-xs text-muted">Input tokens</p>
              <p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {{ summary.totals.inputTokensAvailable ? formatTokens(summary.totals.inputTokens) : "—" }}
              </p>
            </div>
            <div class="rounded-lg border border-default bg-elevated/30 p-4">
              <p class="text-xs text-muted">Output tokens</p>
              <p class="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {{ summary.totals.outputTokensAvailable ? formatTokens(summary.totals.outputTokens) : "—" }}
              </p>
            </div>
          </section>

          <section class="rounded-lg border border-default p-4 sm:p-6">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-sm font-semibold">
                {{ summary.resolution === "hour" ? "Hourly" : "Daily" }} {{ metric === "cost" ? "cost" : "tokens" }}
              </h2>
              <p class="text-xs text-muted">
                {{ formatPeriod(summary.from, summary.resolution) }}–{{ formatPeriod(summary.to, summary.resolution) }}
              </p>
            </div>
            <div class="mt-8 flex h-56 items-end gap-px border-b border-default" aria-label="Usage over time">
              <UTooltip
                v-for="bucket in chartBuckets"
                :key="bucket.start"
                :text="`${formatPeriod(bucket.start, summary.resolution)}: ${formatValue(bucket)}`"
              >
                <div class="flex h-full min-w-0 flex-1 items-end">
                  <span
                    class="w-full rounded-t-sm bg-primary/70 transition-[height]"
                    :style="{ height: `${bucket.height}%` }"
                  />
                </div>
              </UTooltip>
            </div>
          </section>

          <section class="overflow-hidden rounded-lg border border-default">
            <div class="border-b border-default px-4 py-3 sm:px-5">
              <h2 class="text-sm font-semibold">Models</h2>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full min-w-lg text-sm">
                <thead class="text-left text-xs text-muted">
                  <tr>
                    <th class="px-4 py-3 font-medium sm:px-5">Model</th>
                    <th class="px-4 py-3 text-right font-medium">Calls</th>
                    <th class="px-4 py-3 text-right font-medium">Tokens</th>
                    <th class="px-4 py-3 text-right font-medium sm:px-5">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="model in summary.models" :key="model.model" class="border-t border-default">
                    <td class="px-4 py-3 font-medium sm:px-5">{{ model.model }}</td>
                    <td class="px-4 py-3 text-right tabular-nums text-muted">{{ formatTokens(model.invocations) }}</td>
                    <td class="px-4 py-3 text-right tabular-nums">
                      {{ model.totalTokensAvailable ? formatTokens(model.totalTokens) : "—" }}
                    </td>
                    <td class="px-4 py-3 text-right tabular-nums sm:px-5">
                      {{ model.costAvailable ? formatCost(model.costUsd) : "—" }}
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
