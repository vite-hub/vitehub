<script setup lang="ts">
import {
  type AgentTrace as AgentTraceComponent,
  useAgentFileTree,
  useAgentFileTreeSelection,
} from "@vite-hub/ui";
import { computed } from "vue";

type TraceRun = InstanceType<typeof AgentTraceComponent>["$props"]["run"];

// Synthetic review data. In an application, read patches from the Agent's change activity or Git.
const patches: Record<string, string> = {
  "src/status.ts": `diff --git a/src/status.ts b/src/status.ts
--- a/src/status.ts
+++ b/src/status.ts
@@ -1,3 +1,4 @@
 export function statusLabel(running: boolean) {
-  return running ? 'Running' : 'Done'
+  if (running) return 'Working'
+  return 'Completed'
 }`,
  "src/retry.ts": `diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,6 +1,8 @@
-export async function retry(task: () => Promise<void>) {
-  for (let attempt = 0; attempt < 3; attempt++) {
+export async function retry(task: () => Promise<void>, attempts = 3) {
+  for (let attempt = 0; attempt < attempts; attempt++) {
     try {
       return await task()
-    } catch {}
+    } catch (error) {
+      if (attempt === attempts - 1) throw error
+    }
   }
 }`,
  "test/status.test.ts": `diff --git a/test/status.test.ts b/test/status.test.ts
--- a/test/status.test.ts
+++ b/test/status.test.ts
@@ -3,4 +3,4 @@ import { statusLabel } from "../src/status"

 it("labels a finished run", () => {
-  expect(statusLabel(false)).toBe("Done")
+  expect(statusLabel(false)).toBe("Completed")
 })`,
};

const tree = useAgentFileTree({
  paths: [...Object.keys(patches), "src/index.ts", "package.json"],
  initialExpansion: "open",
  initialSelectedPaths: ["src/status.ts"],
  gitStatus: [
    { path: "src/status.ts", status: "modified" },
    { path: "src/retry.ts", status: "modified" },
    { path: "test/status.test.ts", status: "modified" },
  ],
});
const selectedPaths = useAgentFileTreeSelection(tree);
const selectedPath = computed(() => selectedPaths.value.find((path) => path in patches));

const verification: TraceRun = {
  durationMs: 2_840,
  endTime: "2026-08-23T09:04:12.840Z",
  events: [],
  id: "run_review",
  startTime: "2026-08-23T09:04:10.000Z",
  status: "completed",
  steps: [
    {
      attributes: { command: "pnpm typecheck" },
      durationMs: 1_210,
      endTime: "2026-08-23T09:04:11.210Z",
      events: [],
      id: "typecheck",
      name: "Typecheck",
      startTime: "2026-08-23T09:04:10.000Z",
      status: "completed",
      type: "run",
    },
    {
      attributes: { command: "pnpm test status", exitCode: 0 },
      durationMs: 1_630,
      endTime: "2026-08-23T09:04:12.840Z",
      events: [],
      id: "test",
      name: "Run focused tests",
      startTime: "2026-08-23T09:04:11.210Z",
      status: "completed",
      type: "run",
    },
  ],
};
</script>

<template>
  <div class="@container min-w-0 bg-default">
    <div class="grid @2xl:h-[34rem] @2xl:grid-cols-[14rem_minmax(0,1fr)]">
      <div class="h-48 min-h-0 overflow-auto border-b border-default p-2 @2xl:h-auto @2xl:border-e @2xl:border-b-0">
        <AgentFileTree :model="tree" aria-label="Changed files" />
      </div>
      <div class="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto p-3">
        <AgentPatchDiff v-if="selectedPath" :key="selectedPath" :patch="patches[selectedPath]!" />
        <p v-else class="grid flex-1 place-items-center text-sm text-muted">
          Select a changed file to review its diff.
        </p>
        <AgentTrace :run="verification">
          <template #title>Verification</template>
        </AgentTrace>
      </div>
    </div>
  </div>
</template>
