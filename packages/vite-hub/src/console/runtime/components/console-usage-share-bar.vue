<script setup lang="ts">
import { computed } from "vue";

import { formatConsoleUsageShare, type ConsoleUsageSegment } from "./console-usage-model";
import ConsoleSection from "./console-section.vue";

const props = defineProps<{
  format: (value: number) => string;
  label: string;
  note?: string;
  segments: ConsoleUsageSegment[];
}>();

// Empty segments stay out of the bar and the legend.
const visible = computed(() => props.segments.filter(segment => segment.value > 0));
const total = computed(() => visible.value.reduce((sum, segment) => sum + segment.value, 0));
const description = computed(() =>
  `${props.label}: ${visible.value.map(segment => `${segment.label} ${props.format(segment.value)}`).join(", ")}`,
);

function tooltip(segment: ConsoleUsageSegment): string {
  return `${segment.label} · ${props.format(segment.value)} · ${formatConsoleUsageShare(segment.value / total.value)}`;
}
</script>

<template>
  <ConsoleSection v-if="total > 0" :level="3" :title="label" data-slot="usage-share-bar">
    <template v-if="$slots.aside" #actions>
      <slot name="aside" />
    </template>
    <div role="img" :aria-label="description" class="flex h-2 gap-0.5">
      <UTooltip v-for="segment in visible" :key="segment.key" :text="tooltip(segment)">
        <div
          class="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
          :style="{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }"
        />
      </UTooltip>
    </div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span v-for="segment in visible" :key="segment.key" class="flex items-center gap-1.5">
        <span aria-hidden="true" class="size-2 rounded-xs" :style="{ backgroundColor: segment.color }" />
        <span class="text-muted">{{ segment.label }}</span>
        <span class="tabular-nums">{{ format(segment.value) }}</span>
      </span>
    </div>
    <p v-if="note" class="text-xs text-muted">{{ note }}</p>
  </ConsoleSection>
</template>
