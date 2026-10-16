<script lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

// One clock for every relative time on the page. It ticks while at least one is mounted.
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function useNow() {
  onMounted(() => {
    now.value = Date.now();
    if (users++ === 0) timer = setInterval(() => (now.value = Date.now()), 15_000);
  });
  onBeforeUnmount(() => {
    if (--users === 0 && timer) clearInterval(timer);
  });
  return now;
}
</script>

<script setup lang="ts">
import { computed } from "vue";

import { exactTimestamps, recentTimestamp } from "../client/time";

/**
 * A relative time such as `just now`, `5m ago`, or `Oct 12`, with the exact UTC and local time in a tooltip (Geist
 * Relative Time Card). Numbers use tabular figures so a ticking label does not shift.
 */
const props = defineProps<{
  /** Text before the time, such as `Saved`. */
  prefix?: string;
  value: string;
}>();

const clock = useNow();
const label = computed(() => {
  const relative = recentTimestamp(props.value, clock.value);
  if (!relative) return props.value;
  return relative === "now" ? "just now" : relative;
});
const exact = computed(() => exactTimestamps(props.value));
</script>

<template>
  <UTooltip :delay-duration="150" :content="{ side: 'bottom' }" :ui="{ content: 'h-auto' }">
    <time :datetime="value" class="tabular-nums">{{ prefix ? `${prefix} ${label}` : label }}</time>
    <template #content>
      <span v-if="exact" class="grid gap-0.5 py-1 text-xs tabular-nums">
        <span>{{ exact.utc }}</span>
        <span class="text-muted">{{ exact.local }}</span>
      </span>
    </template>
  </UTooltip>
</template>
