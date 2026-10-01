<script setup lang="ts">
import { useAgentFileTree, useAgentFileTreeSelection } from "@vite-hub/ui";

const tree = useAgentFileTree({
  paths: [
    "src/status.ts",
    "src/retry.ts",
    "src/components/InvocationList.vue",
    "test/status.test.ts",
    "package.json",
  ],
  initialExpansion: "open",
  initialSelectedPaths: ["src/status.ts"],
  gitStatus: [
    { path: "src/status.ts", status: "modified" },
    { path: "src/retry.ts", status: "added" },
    { path: "test/status.test.ts", status: "modified" },
  ],
});

// A reactive copy of the model's selection. It updates when the viewer selects a row.
const selectedPaths = useAgentFileTreeSelection(tree);

// Drive the same model from application code.
function selectOnly(path: string) {
  for (const selected of tree.getSelectedPaths()) tree.getItem(selected)?.deselect();
  tree.getItem(path)?.select();
}
</script>

<template>
  <div class="mx-auto grid max-w-2xl gap-3 sm:grid-cols-[1fr_12rem]">
    <div class="h-72 overflow-auto rounded-md border border-default bg-default p-2">
      <AgentFileTree :model="tree" aria-label="Changed files" />
    </div>
    <div class="space-y-2 text-xs">
      <p class="font-medium text-highlighted">Selected</p>
      <ul class="space-y-1 font-mono text-muted">
        <li v-for="path in selectedPaths" :key="path">{{ path }}</li>
      </ul>
      <UButton label="Select retry.ts" color="neutral" variant="outline" size="xs" @click="selectOnly('src/retry.ts')" />
    </div>
  </div>
</template>
