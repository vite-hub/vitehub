<template>
  <nav class="not-prose vh-learning-paths" aria-label="Documentation paths">
    <slot />
  </nav>
</template>

<style scoped>
.vh-learning-paths :deep(ul) {
  display: grid;
  gap: 0 2rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vh-learning-paths :deep(li) {
  margin: 0;
  border-bottom: 1px solid var(--ui-border);
  padding-block: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.5rem;
  text-wrap: pretty;
}

.vh-learning-paths :deep(a) {
  display: block;
  margin-bottom: 0.25rem;
  color: var(--ui-text-highlighted);
  font-size: 1rem;
  font-weight: 500;
  text-decoration: none;
}

.vh-learning-paths :deep(a:hover) {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.vh-learning-paths :deep(a:focus-visible) {
  outline: 2px solid var(--ui-primary);
  outline-offset: 4px;
}

@media (min-width: 40rem) {
  .vh-learning-paths :deep(ul) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
