<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{ usage: Record<string, unknown> }>()

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatTokens(value: unknown): string {
  const resolved = number(value) ?? 0
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: resolved >= 10_000 ? "compact" : "standard",
  }).format(resolved)
}

const cost = computed(() => {
  const value = props.usage.cost
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
})
</script>

<template>
  <section>
    <h4>Usage</h4>
    <dl class="grid grid-cols-2 gap-3">
      <div>
        <dt class="text-xs text-muted">Processed tokens</dt>
        <dd class="mt-1 text-sm font-semibold tabular-nums">
          {{ formatTokens(usage.totalTokens) }}
        </dd>
      </div>
      <div v-if="cost">
        <dt class="text-xs text-muted">Cost</dt>
        <dd class="mt-1 text-sm font-semibold tabular-nums">{{ cost.display }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">Input</dt>
        <dd class="mt-1 text-xs tabular-nums text-toned">{{ formatTokens(usage.inputTokens) }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted">Output</dt>
        <dd class="mt-1 text-xs tabular-nums text-toned">{{ formatTokens(usage.outputTokens) }}</dd>
      </div>
      <div v-if="number(usage.cachedInputTokens) !== undefined">
        <dt class="text-xs text-muted">Cached input</dt>
        <dd class="mt-1 text-xs tabular-nums text-toned">{{ formatTokens(usage.cachedInputTokens) }}</dd>
      </div>
      <div v-if="number(usage.reasoningTokens) !== undefined">
        <dt class="text-xs text-muted">Reasoning</dt>
        <dd class="mt-1 text-xs tabular-nums text-toned">{{ formatTokens(usage.reasoningTokens) }}</dd>
      </div>
    </dl>
    <p v-if="cost" class="mt-3 text-[11px] leading-4 text-dimmed">
      {{ cost.estimated === true ? "Estimated" : "Reported" }} by {{ cost.source }}
    </p>
  </section>
</template>
