<script setup lang="ts">
import { getSingularPatch, type CodeViewItem } from "@vite-hub/ui";
import { ref } from "vue";

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

const oldFile = {
  contents: "export const status = 'running'\n",
  name: "src/status.ts",
};
const newFile = {
  contents: "export const status = 'completed'\n",
  name: "src/status.ts",
};
const conflictStart = "<".repeat(7);
const conflictSeparator = "=".repeat(7);
const conflictEnd = ">".repeat(7);
const unresolvedFile = {
  contents: `${conflictStart} current
export const status = 'running'
${conflictSeparator}
export const status = 'completed'
${conflictEnd} incoming
`,
  name: "src/status.ts",
};
const fileDiff = getSingularPatch(patch);
const codeViewItems: CodeViewItem[] = [
  { file: newFile, id: "file", type: "file" },
  { fileDiff, id: "diff", type: "diff" },
];
const views = ["CodeView", "MultiFileDiff", "PatchDiff", "FileDiff", "File", "UnresolvedFile"] as const;
const activeView = ref<(typeof views)[number]>("PatchDiff");
</script>

<template>
  <div class="min-w-0">
    <div class="mb-3 flex gap-1 overflow-x-auto rounded-md border border-default bg-muted p-1">
      <UButton
        v-for="view in views"
        :key="view"
        :label="view"
        color="neutral"
        size="xs"
        :variant="activeView === view ? 'solid' : 'ghost'"
        @click="activeView = view"
      />
    </div>

    <AgentCodeView
      v-if="activeView === 'CodeView'"
      class="h-80"
      :items="codeViewItems"
    />
    <AgentMultiFileDiff
      v-else-if="activeView === 'MultiFileDiff'"
      :new-file="newFile"
      :old-file="oldFile"
    />
    <AgentPatchDiff
      v-else-if="activeView === 'PatchDiff'"
      :patch="patch"
    />
    <AgentFileDiff
      v-else-if="activeView === 'FileDiff'"
      :file-diff="fileDiff"
    />
    <AgentFile
      v-else-if="activeView === 'File'"
      :file="newFile"
    />
    <AgentUnresolvedFile
      v-else
      :file="unresolvedFile"
    />
  </div>
</template>
