<script setup lang="ts">
const paths = [
  "src/status.ts",
  "src/components/InvocationList.vue",
  "src/components/InvocationDetails.vue",
  "test/invocation-list.test.ts",
  "README.md",
];
</script>

<template>
  <div class="mx-auto h-80 max-w-lg overflow-auto rounded-md border border-default bg-default p-2">
    <AgentFileTree :paths="paths" :options="{ initialExpansion: 'open', search: true }" />
  </div>
</template>
