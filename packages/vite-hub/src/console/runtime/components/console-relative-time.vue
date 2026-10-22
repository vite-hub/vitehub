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
import { computed, watch } from "vue";

import { exactTimestamps, recentTimestamp } from "../client/time";

/**
 * A relative time such as `just now`, `5m ago`, or `Oct 12`, with the exact UTC and local time in a tooltip (Geist
 * Relative Time Card). Numbers use tabular figures so a ticking label does not shift.
 */
const props = defineProps<{
  /** Text before the time, such as `Saved`. */
  prefix?: string;
  /** Count the first minute in seconds, such as `Saved 3s ago`. The label then ticks every second for that minute. */
  seconds?: boolean;
  value: string;
}>();

const clock = useNow();
const label = computed(() => {
  const relative = recentTimestamp(props.value, clock.value, { seconds: props.seconds });
  if (!relative) return props.value;
  return relative === "now" ? "just now" : relative;
});
const exact = computed(() => exactTimestamps(props.value));

// A second-precision label ticks on its own until it reaches minutes, then follows the shared clock.
let fast: ReturnType<typeof setInterval> | undefined;
function stopFast(): void {
  if (fast) clearInterval(fast);
  fast = undefined;
}
watch(() => [props.value, props.seconds] as const, ([value, seconds]) => {
  stopFast();
  if (!seconds) return;
  clock.value = Date.now();
  fast = setInterval(() => {
    clock.value = Date.now();
    if (Date.now() - Date.parse(value) >= 60_000) stopFast();
  }, 1_000);
}, { immediate: true });
onBeforeUnmount(stopFast);
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
