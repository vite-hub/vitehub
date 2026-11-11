<script setup lang="ts">
defineProps<{
  description: string
  label: string
  title: string
  to: string
}>()
</script>

<template>
  <ULink
    :to="to"
    class="property-help"
    :aria-label="`${title}: ${description}`"
  >
    {{ label }}
  </ULink>
</template>

<style scoped>
.property-help {
  color: var(--ui-text-highlighted);
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
</style>
