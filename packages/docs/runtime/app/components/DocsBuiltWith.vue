<script setup lang="ts">
const { builtWith } = useDocsConfig()
</script>

<template>
  <p v-if="builtWith" class="vh-docs-credit">
    Built with <a href="https://vitehub.dev/docs/docs-site" target="_blank" rel="noopener">ViteHub Docs</a>
  </p>
</template>

<style scoped>
.vh-docs-credit {
  color: var(--ui-text-dimmed);
  font-size: 0.75rem;
  line-height: 1.25rem;
}

.vh-docs-credit a {
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-decoration-color: var(--ui-border-accented);
  text-underline-offset: 3px;
}

@media (hover: hover) {
  .vh-docs-credit a:hover {
    color: var(--ui-text-highlighted);
    text-decoration-color: currentcolor;
  }
}
</style>
