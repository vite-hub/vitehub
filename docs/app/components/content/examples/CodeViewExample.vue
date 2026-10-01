<script setup lang="ts">
import { getSingularPatch, type CodeViewItem } from "@vite-hub/ui";

const patch = `diff --git a/src/status.ts b/src/status.ts
--- a/src/status.ts
+++ b/src/status.ts
@@ -1,3 +1,4 @@
 export function statusLabel(running: boolean) {
-  return running ? 'Running' : 'Done'
+  if (running) return 'Working'
+  return 'Completed'
 }`;

// Mix full files and diffs in one virtualized list.
const items = [
  { id: "diff", type: "diff", fileDiff: getSingularPatch(patch) },
  {
    id: "test",
    type: "file",
    file: {
      name: "test/status.test.ts",
      contents: `import { expect, it } from "vitest"
import { statusLabel } from "../src/status"

it("labels a finished run", () => {
  expect(statusLabel(false)).toBe("Completed")
})
`,
    },
  },
] satisfies CodeViewItem<undefined>[];
</script>

<template>
  <AgentCodeView class="h-96" :items="items" />
</template>
