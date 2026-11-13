<script setup lang="ts">
import { computed } from "vue";

import ConsoleUsageChart from "./console-usage-chart.vue";
import ConsoleUsageShareBar from "./console-usage-share-bar.vue";
import {
  consoleUsageCacheHitRate,
  consoleUsageCostPerMillionTokens,
  consoleUsageModelChartPoints,
  consoleUsageModelShare,
  consoleUsageTokenSegments,
  formatConsoleUsageCost,
  formatConsoleUsageCostEvidence,
  formatConsoleUsagePeriod,
  formatConsoleUsageShare,
  formatConsoleUsageTokenEvidence,
  formatConsoleUsageTokens,
  type ConsoleUsageEvidence,
  type ConsoleUsageMetric,
  type ConsoleUsageModelTotals,
} from "./console-usage-model";
import ConsoleSection from "./console-section.vue";
import ConsoleStatGrid from "./console-stat-grid.vue";

const props = defineProps<{
  /** Period totals decide whether a period without this model is zero or unavailable. */
  buckets: Array<ConsoleUsageEvidence & { models: ConsoleUsageModelTotals[]; start: string }>;
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
const chartMetric = computed<ConsoleUsageMetric>(() => (props.metric === "cost" && !priced.value ? "tokens" : props.metric));
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
      label: "Sessions",
      value: formatConsoleUsageTokenEvidence(props.model.invocations, props.model.invocationsAvailable),
    },
    props.costSupported && props.model.averageCostUsd !== undefined
      ? {
          label: "Average per priced session",
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
  consoleUsageModelChartPoints(props.buckets, props.model.model, chartMetric.value, props.resolution),
);
const chartTitle = computed(() =>
  `${props.resolution === "hour" ? "Hourly" : "Daily"} ${chartMetric.value}`,
);

function formatChartNumber(value: number): string {
  if (chartMetric.value === "sessions") return value.toLocaleString("en");
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
      · {{ formatConsoleUsagePeriod(from, resolution) }} to {{ formatConsoleUsagePeriod(to, resolution) }} UTC
    </p>
    <ConsoleStatGrid :items="stats" size="lg" :label="`${model.model} totals`" />
    <ConsoleSection :level="3" :title="chartTitle" :description="resolution === 'hour' ? 'UTC hours' : 'UTC days'">
      <ConsoleUsageChart
        :points="points"
        :format="formatChartNumber"
        :title="`${model.model} ${chartTitle.toLowerCase()}`"
        :value-label="chartMetric === 'cost' ? 'Cost' : chartMetric === 'sessions' ? 'Sessions' : 'Tokens'"
        :empty="`No recorded ${chartMetric} for this model`"
        :unavailable="chartMetric === 'cost' ? 'Cost is unavailable for this model' : chartMetric === 'sessions' ? 'Sessions are unavailable for this model' : 'Token usage is unavailable for this model'"
        :from="formatConsoleUsagePeriod(from, resolution)"
        :to="formatConsoleUsagePeriod(to, resolution)"
      />
    </ConsoleSection>
    <ConsoleUsageShareBar
      label="Tokens by type"
      :segments="segments.segments"
      :format="formatConsoleUsageTokens"
      :note="segments.complete ? undefined : 'Recorded evidence only. Some sessions did not report every token type. Input can include their cache tokens.'"
    />
    <p v-if="costSupported && !priced" class="flex items-start gap-2 text-xs text-muted">
      <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      No session recorded a cost for this model. Its cost is unavailable, not zero.
    </p>
  </div>
</template>
