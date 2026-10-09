<script setup lang="ts">
defineProps<{
  id?: string;
  title?: string;
}>();
</script>

<template>
  <section :id="id" class="vh-tutorial-step">
    <slot />
  </section>
</template>

<style scoped>
.vh-tutorial-step {
  counter-increment: tutorial-step;
  margin-block: 2.5rem;
  scroll-margin-top: calc(var(--ui-header-height) + 2rem);
}

.vh-tutorial-step :deep(h2:first-child) {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.vh-tutorial-step :deep(h2:first-child)::before {
  content: counter(tutorial-step) ".";
  flex: none;
  color: var(--ui-text-dimmed);
  font-variant-numeric: tabular-nums;
  font-size: 1rem;
}

.vh-tutorial-step :deep(pre) {
  white-space: pre;
  overflow-x: auto;
}
</style>
