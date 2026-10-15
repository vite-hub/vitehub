<script setup lang="ts">
import { computed } from "vue";

import { consoleStatusValue, consoleValueParts } from "../client/format";
import ConsoleRelativeTime from "./console-relative-time.vue";
import ConsoleStatus from "./console-status.vue";

/**
 * A text value from an owner package, shown the Console way: a status word such as `Enabled` or `failed` as a status
 * dot, `succeeded at <timestamp>` as a status and a relative time, every other timestamp as a relative time with the
 * exact time in a tooltip, and text in backticks as code. Other text shows as it is.
 */
const props = defineProps<{ value: string }>();

const status = computed(() => consoleStatusValue(props.value));
// `succeeded at 2026-10-15T11:00:00.000Z`, as Schedule's last run reads.
const statusAt = computed(() => {
  const parts = consoleValueParts(props.value);
  const [first, time] = parts;
  if (parts.length !== 2 || first?.kind !== "text" || time?.kind !== "time" || !first.value.endsWith(" at ")) return undefined;
  const value = consoleStatusValue(first.value.slice(0, -4));
  return value ? { status: value, time: time.value } : undefined;
});
const parts = computed(() => consoleValueParts(props.value));
</script>

<template>
  <ConsoleStatus v-if="status" :label="status.label" :tone="status.tone" :pending="status.pending" />
  <span v-else-if="statusAt" class="inline-flex min-w-0 items-center gap-1.5">
    <ConsoleStatus :label="statusAt.status.label" :tone="statusAt.status.tone" :pending="statusAt.status.pending" />
    <span class="text-dimmed" aria-hidden="true">·</span>
    <span class="text-xs text-muted"><ConsoleRelativeTime :value="statusAt.time" /></span>
  </span>
  <span v-else><template v-for="(part, index) in parts" :key="index"><ConsoleRelativeTime v-if="part.kind === 'time'" :value="part.value" /><code v-else-if="part.kind === 'code'" class="rounded-sm bg-elevated px-1 py-px font-mono text-[0.9em] text-highlighted">{{ part.value }}</code><template v-else>{{ part.value }}</template></template></span>
</template>
