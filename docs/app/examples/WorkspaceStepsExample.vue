<script setup lang="ts">
import { WorkspaceSteps } from "@vite-hub/ui/workspace";
import { ref } from "vue";

const steps = [
  { title: "Write a component", description: "Glosa reads the text." },
  { title: "Translate it", description: "One catalog per locale." },
  { title: "Plurals", description: "Counts that read right." },
];
const step = ref(0);
</script>

<template>
  <div class="flex h-11 items-center border-b border-default px-2">
    <WorkspaceSteps v-model:step="step" :steps label="Translate an app" />
  </div>
</template>
