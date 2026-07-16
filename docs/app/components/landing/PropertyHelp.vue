<script setup lang="ts">
defineProps<{
  description: string
  label: string
  title: string
  to: string
}>()
</script>

<template>
  <UPopover
    :content="{ align: 'start', side: 'top', sideOffset: 8 }"
    :ui="{ content: 'max-w-64 p-3' }"
  >
    <button type="button" class="property-help" :aria-label="`About ${label}`">
      {{ label }}
    </button>

    <template #content>
      <div class="space-y-1.5">
        <p class="text-xs font-semibold text-highlighted">
          {{ title }}
        </p>
        <p class="text-xs/5 text-muted">
          {{ description }}
        </p>
        <ULink :to="to" class="inline-flex text-xs font-medium text-primary hover:underline">
          Read the docs&nbsp;→
        </ULink>
      </div>
    </template>
  </UPopover>
</template>

<style scoped>
.property-help {
  border: 0;
  color: var(--ui-text-highlighted);
  cursor: help;
  font: inherit;
  line-height: inherit;
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: color-mix(in srgb, var(--ui-text-muted) 55%, transparent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.25rem;
  transition: color 150ms ease, text-decoration-color 150ms ease;
}

.property-help:hover {
  color: var(--ui-primary);
  text-decoration-color: currentColor;
}

.property-help:focus-visible {
  border-radius: 0.125rem;
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
</style>
