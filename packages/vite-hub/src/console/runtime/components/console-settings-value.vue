<script setup lang="ts">
import { useConsoleToast } from "../client/toast";

/** A value that the Console reads and does not change, such as an ID, in a field-shaped box. `copy` adds a copy button. */
const props = defineProps<{
  value?: string;
  label: string;
  mono?: boolean;
  copy?: boolean;
  /** A skeleton holds the place of a value that has not loaded. */
  loading?: boolean;
}>();

const toast = useConsoleToast();

async function copyValue(): Promise<void> {
  if (!props.value) return;
  const copied = await navigator.clipboard.writeText(props.value).then(() => true, () => false);
  toast.show({ title: copied ? `${props.label} copied` : "The browser blocked the clipboard. Select the value and copy it." });
}
</script>

<template>
  <div class="vitehub-settings-value">
    <USkeleton v-if="loading" class="h-3 w-40" />
    <span v-else class="min-w-0 flex-1 truncate" :class="mono ? 'font-mono text-[0.8125rem]' : ''"><slot>{{ value }}</slot></span>
    <UTooltip v-if="copy && value && !loading" :text="`Copy ${label.toLowerCase()}`">
      <UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="`Copy ${label.toLowerCase()}`" @click="copyValue" />
    </UTooltip>
  </div>
</template>

<style>
.vitehub-settings-value {
  align-items: center;
  background: var(--ui-bg-muted);
  border: 1px solid var(--ui-border);
  border-radius: 0.375rem;
  display: flex;
  font-size: 0.875rem;
  gap: 0.5rem;
  max-width: 26.25rem;
  min-height: 2.125rem;
  padding: 0 0.25rem 0 0.625rem;
}
</style>
