<script setup lang="ts">
import { useWorkspace } from "@vite-hub/ui/workspace"

// The Changes tab of /docs/try/playground: the files that the reader edited in the open example.
const { edited, example } = useWorkspace()
</script>

<template>
  <div class="p-4 text-sm">
    <p v-if="edited.length === 0" class="text-muted">You did not change {{ example.label }} yet.</p>
    <ul v-else class="grid gap-1">
      <li v-for="path in edited" :key="path" class="font-mono">{{ path }}</li>
    </ul>
  </div>
</template>
