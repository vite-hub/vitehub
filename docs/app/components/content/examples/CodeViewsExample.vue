<script setup lang="ts">
const patch = `diff --git a/src/status.ts b/src/status.ts
index 0f62a11..12b7409 100644
--- a/src/status.ts
+++ b/src/status.ts
@@ -1,3 +1,4 @@
 export function statusLabel(running: boolean) {
-  return running ? 'Running' : 'Done'
+  if (running) return 'Working'
+  return 'Completed'
 }`;

const paths = [
  "src/status.ts",
  "src/components/InvocationList.vue",
  "test/invocation-list.test.ts",
  "README.md",
];
</script>

<template>
  <div class="grid min-w-0 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
    <div class="h-80 overflow-auto rounded-md border border-default bg-default p-2">
      <AgentFileTree :paths="paths" :options="{ initialExpansion: 'open', search: true }" />
    </div>
    <div class="min-w-0 overflow-auto rounded-md border border-default bg-default">
      <AgentDiff :patch="patch" />
    </div>
  </div>
</template>
