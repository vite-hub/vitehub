<script setup lang="ts">
import { WorkspaceFileLink } from "@vite-hub/ui/workspace"

defineProps<{ path: string }>()
</script>

<template>
  <WorkspaceFileLink :path="path" class="vh-docs-learn-file"><slot /></WorkspaceFileLink>
</template>

<style scoped>
.vh-docs-learn-file {
  cursor: pointer;
  text-decoration: underline dotted var(--ui-border-accented);
  text-underline-offset: 0.25em;
}

.vh-docs-learn-file:hover {
  text-decoration-color: var(--ui-text-muted);
}
</style>
