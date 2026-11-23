<script setup lang="ts">
import { ref } from "vue";
import { WorkspaceExamples, type WorkspaceExample } from "@vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "empty", label: "Empty", description: "A package.json and an index page." },
  { id: "vue", label: "Vue", group: "Source language", description: "A greeting in two languages." },
  { id: "svelte", label: "Svelte", group: "Source language", description: "The same app, written in Svelte 5." },
  { id: "fallbacks", label: "Fallbacks", group: "Recipes", description: "What shows before a translation exists." },
];
const example = ref("vue");
</script>

<template>
  <div class="flex items-center gap-3">
    <WorkspaceExamples v-model="example" :examples />
    <span class="text-sm text-muted">Open: {{ example }}</span>
  </div>
</template>
