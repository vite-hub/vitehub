<script setup lang="ts">
/**
 * A status as a dot and a sentence-case label (Geist Status Dot). Only the dot carries color; the label stays muted, so
 * color never carries the meaning alone. `pending` pulses the dot while work is in progress.
 */
withDefaults(defineProps<{
  label: string;
  pending?: boolean;
  tone?: "error" | "neutral" | "success" | "warning";
}>(), { tone: "neutral" });
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
    <span
      class="size-2 shrink-0 rounded-full"
      :class="[
        tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : tone === 'error' ? 'bg-error' : 'bg-transparent ring-1 ring-(--ui-text-dimmed) ring-inset',
        pending ? 'motion-safe:animate-pulse' : '',
      ]"
      aria-hidden="true"
    />
    <span class="truncate"><slot>{{ label }}</slot></span>
  </span>
</template>
