<script setup lang="ts">
// A linked feature in the product landing list.
defineProps<{
  title: string;
  /** Icon shown beside the title. */
  icon?: string;
  /** Docs page that explains the feature in full. */
  to: string;
}>();
</script>

<template>
  <NuxtLink :to="to" class="vh-feature-item group">
    <UIcon
      v-if="icon"
      :name="icon"
      class="vh-feature-icon size-4 shrink-0 text-muted"
      aria-hidden="true"
    />
    <h2 class="vh-feature-item-title">
      <span>{{ title }}</span>
      <UIcon
        name="i-lucide-arrow-right"
        class="landing-cta-arrow size-3.5 shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none"
        aria-hidden="true"
      />
    </h2>
    <div class="vh-feature-item-body">
      <slot />
    </div>
  </NuxtLink>
</template>

<style scoped>
.vh-feature-item {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr);
  align-content: start;
  gap: 0.5rem 0.75rem;
  padding: 0.5rem 0;
  border-radius: var(--ui-radius);
  transition: background-color 150ms ease;
}

.vh-feature-item:hover {
  background: color-mix(in srgb, var(--ui-bg-muted) 35%, var(--ui-bg));
}

.vh-feature-item:hover .landing-cta-arrow {
  transform: translateX(0.25rem);
}

.vh-feature-item:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.vh-feature-item-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  grid-column: 2;
  margin: 0;
  color: var(--ui-text-highlighted);
  font-size: 0.9375rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.375rem;
}

.vh-feature-icon {
  margin-top: 0.15rem;
}

.vh-feature-item-body {
  grid-column: 2;
}

.vh-feature-item-body,
.vh-feature-item-body :deep(p) {
  margin: 0;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  line-height: 1.25rem;
  text-wrap: pretty;
}

.vh-feature-item-body :deep(code) {
  display: inline;
  border: 0;
  border-radius: 0;
  background: none;
  padding: 0;
  color: var(--ui-text-toned);
  font-size: 0.75rem;
}

@media (prefers-reduced-motion: reduce) {
  .vh-feature-item {
    transition: none;
  }
}
</style>
