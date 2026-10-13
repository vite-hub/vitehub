<script setup lang="ts">
import { computed } from "vue";

import ConsoleUsageChart from "./console-usage-chart.vue";
import ConsoleUsageShareBar from "./console-usage-share-bar.vue";
import {
  consoleUsageCacheHitRate,
  consoleUsageCostPerMillionTokens,
  consoleUsageMetricValue,
  consoleUsageModelPeriods,
  consoleUsageModelShare,
  consoleUsageTokenSegments,
  formatConsoleUsageCost,
  formatConsoleUsageCostEvidence,
  formatConsoleUsagePeriod,
  formatConsoleUsageShare,
  formatConsoleUsageTokenEvidence,
  formatConsoleUsageTokens,
  formatConsoleUsageValue,
  type ConsoleUsageEvidence,
  type ConsoleUsageMetric,
  type ConsoleUsageModelTotals,
} from "./console-usage-model";

const props = defineProps<{
  buckets: Array<{ models: ConsoleUsageModelTotals[]; start: string }>;
  costSupported: boolean;
  from: string;
  metric: ConsoleUsageMetric;
  model: ConsoleUsageModelTotals;
  resolution: "day" | "hour";
  to: string;
  totals: ConsoleUsageEvidence;
}>();

const priced = computed(() => props.costSupported && props.model.pricedInvocations > 0);
// A model without recorded cost has an unknown cost, not a zero cost, so its trend shows tokens.
const chartMetric = computed<ConsoleUsageMetric>(() => (priced.value ? props.metric : "tokens"));
// Without a recorded cost, the share also follows tokens.
const share = computed(() => consoleUsageModelShare(props.model, props.totals, chartMetric.value));
const segments = computed(() => consoleUsageTokenSegments(props.model));
const perMillion = computed(() => consoleUsageCostPerMillionTokens(props.model));
const hitRate = computed(() => consoleUsageCacheHitRate(props.model));
const stats = computed(() =>
  [
    props.costSupported
      ? {
          label: "Cost",
          value: formatConsoleUsageCostEvidence(
            props.model.costUsd,
            props.model.costEstimated,
            props.model.costAvailable,
          ),
        }
      : undefined,
    {
      label: "Tokens",
      value: formatConsoleUsageTokenEvidence(props.model.totalTokens, props.model.totalTokensAvailable),
    },
    {
      label: "Runs",
      value: formatConsoleUsageTokenEvidence(props.model.invocations, props.model.invocationsAvailable),
    },
    props.costSupported && props.model.averageCostUsd !== undefined
      ? {
          label: "Average per priced run",
          value: formatConsoleUsageCost(props.model.averageCostUsd, props.model.costEstimated),
        }
      : undefined,
    perMillion.value === null
      ? undefined
      : {
          label: "Per 1M tokens",
          value: formatConsoleUsageCost(perMillion.value.toFixed(2), props.model.costEstimated),
        },
    hitRate.value === null
      ? undefined
      : { label: "Cache hit", value: formatConsoleUsageShare(hitRate.value) },
    props.model.reasoningTokens > 0 || props.model.reasoningTokensAvailable
      ? {
          label: "Reasoning tokens",
          value: formatConsoleUsageTokenEvidence(
            props.model.reasoningTokens,
            props.model.reasoningTokensAvailable,
          ),
        }
      : undefined,
  ].filter(stat => stat !== undefined),
);
const points = computed(() =>
  consoleUsageModelPeriods(props.buckets, props.model.model).map(({ start, totals }) => {
    const label = formatConsoleUsagePeriod(start, props.resolution);
    if (!totals) return { label: `${label}: no recorded usage`, partial: false, start, value: 0 };
    return {
      label: `${label}: ${formatConsoleUsageValue(totals, chartMetric.value)}`,
      partial: chartMetric.value === "cost" ? !totals.costAvailable : !totals.totalTokensAvailable,
      start,
      value: consoleUsageMetricValue(totals, chartMetric.value),
    };
  }),
);

function formatChartNumber(value: number): string {
  return chartMetric.value === "cost"
    ? formatConsoleUsageCost(String(value))
    : formatConsoleUsageTokens(value);
}
</script>

<template>
  <div class="flex flex-col gap-7" data-slot="usage-model-detail">
    <p class="text-xs text-muted">
      <template v-if="share !== null">{{ formatConsoleUsageShare(share) }} of recorded {{ chartMetric === "cost" ? "cost" : "tokens" }}</template>
      <template v-else>{{ chartMetric === "cost" ? "Cost" : "Token" }} share unavailable</template>
      · {{ formatConsoleUsagePeriod(from, resolution) }} to {{ formatConsoleUsagePeriod(to, resolution) }}
    </p>
    <dl class="grid grid-cols-2 gap-x-6 gap-y-4">
      <div v-for="stat in stats" :key="stat.label" class="min-w-0">
        <dt class="text-xs text-muted">{{ stat.label }}</dt>
        <dd class="mt-1 text-lg font-semibold tabular-nums">{{ stat.value }}</dd>
      </div>
    </dl>
    <section class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold">
        {{ resolution === "hour" ? "Hourly" : "Daily" }} {{ chartMetric === "cost" ? "cost" : "tokens" }}
      </h3>
      <ConsoleUsageChart
        class="mt-2"
        :points="points"
        :format="formatChartNumber"
        :empty="`No recorded ${chartMetric} for this model`"
        :from="formatConsoleUsagePeriod(from, resolution)"
        :to="formatConsoleUsagePeriod(to, resolution)"
      />
    </section>
    <ConsoleUsageShareBar
      label="Tokens by type"
      :segments="segments.segments"
      :format="formatConsoleUsageTokens"
      :note="segments.complete ? undefined : 'Recorded evidence only. Some runs did not report every token type. Input can include their cache tokens.'"
    />
    <p v-if="costSupported && !priced" class="flex items-start gap-2 text-xs text-muted">
      <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
      No run recorded a cost for this model. Its cost is unavailable, not zero.
    </p>
  </div>
</template>
