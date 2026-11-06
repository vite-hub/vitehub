<script setup lang="ts">
import type { DocsDocument } from "@vite-hub/docs"

// The page's `credits` frontmatter, parsed on the server like the body.
defineProps<{
  credits: DocsDocument
}>()
</script>

<template>
  <footer class="vh-docs-credits">
    <DocsMarkdown :document="credits" />
  </footer>
</template>

<style scoped>
.vh-docs-credits {
  border-top: 1px solid var(--ui-border);
  padding-block: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.5rem;
}

.vh-docs-credits :deep(p) {
  margin: 0;
}

.vh-docs-credits :deep(a) {
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: var(--ui-border-accented);
  text-underline-offset: 3px;
}

@media (hover: hover) {
  .vh-docs-credits :deep(a:hover) {
    text-decoration-color: currentcolor;
  }
}
</style>
