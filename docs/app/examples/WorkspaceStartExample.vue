<script setup lang="ts">
import { ref } from "vue";
import { WorkspaceBar, WorkspaceStart, type WorkspaceExample } from "@vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "vue", label: "Vue", description: "A greeting in two languages.", files: { "app.vue": "", "package.json": "" } },
  { id: "react", label: "React", description: "The same app, written in JSX.", files: { "app.tsx": "", "package.json": "" } },
  { id: "empty", label: "Empty", description: "A package.json and an index page.", files: { "package.json": "" } },
];
const picked = ref<string>();
</script>

<template>
  <div class="relative h-96 overflow-hidden rounded-md border border-default">
    <WorkspaceBar />
    <WorkspaceStart v-if="!picked" :examples @pick="picked = $event" />
    <div v-else class="flex items-center gap-3 p-4 text-sm text-muted">
      The {{ picked }} example is open.
      <UButton color="neutral" variant="outline" size="sm" label="Show the start screen" @click="picked = undefined" />
    </div>
  </div>
</template>
