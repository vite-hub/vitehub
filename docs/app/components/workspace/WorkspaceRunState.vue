<script setup lang="ts">
import type { RunTone } from "~/utils/workspace-layout";

defineProps<{ tone: RunTone, label: string }>();
</script>

<template>
  <span class="vh-run-state" :data-tone="tone" role="status">
    <span class="vh-run-state-dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<style scoped>
.vh-run-state {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.vh-run-state-dot {
  width: 0.5rem;
  height: 0.5rem;
  flex: none;
  border-radius: 50%;
  background: var(--ui-text-dimmed);
}

.vh-run-state[data-tone="busy"] .vh-run-state-dot {
  background: var(--ui-warning);
  animation: vh-run-pulse 1.2s ease-in-out infinite;
}

.vh-run-state[data-tone="ready"] .vh-run-state-dot {
  background: var(--ui-success);
}

.vh-run-state[data-tone="error"] {
  color: var(--ui-error);
}

.vh-run-state[data-tone="error"] .vh-run-state-dot {
  background: var(--ui-error);
}

@keyframes vh-run-pulse {
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .vh-run-state[data-tone="busy"] .vh-run-state-dot {
    animation: none;
  }
}
</style>
