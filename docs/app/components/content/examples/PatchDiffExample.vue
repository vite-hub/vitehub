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
</script>

<template>
  <AgentPatchDiff :patch="patch" />
</template>
