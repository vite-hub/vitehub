<script setup lang="ts">
import { WorkspaceFileLink, WorkspaceGuide, WorkspaceTask } from "@vite-hub/ui/workspace";
import { ref } from "vue";

const steps = [
  { title: "Write a component" },
  { title: "Translate it" },
  { title: "Plurals" },
];
const step = ref(1);
</script>

<template>
  <div class="h-[22rem] overflow-hidden rounded-lg border border-default">
    <WorkspaceGuide v-model:step="step" :steps>
      <p v-if="step === 0">Write the text as you always do. Glosa reads it from the template when it builds.</p>
      <p v-else-if="step === 1">
        Each locale has one catalog. <WorkspaceFileLink path="locales/es.json" /> is open below.
      </p>
      <p v-else>Write the plural form once. Each catalog gives its own forms.</p>
      <WorkspaceTask>Change a value and watch the preview.</WorkspaceTask>
      <template #finish>
        <UButton to="/docs/ui/ai-components" color="neutral" size="sm" label="Done" />
      </template>
    </WorkspaceGuide>
  </div>
</template>
