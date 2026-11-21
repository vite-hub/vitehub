<script setup lang="ts">
import { WorkspaceIssues } from "@vite-hub/ui/workspace";

const issues = [
  { line: 3, message: "Expected a comma after the value." },
  { message: "The page has no title." },
];
</script>

<template>
  <div class="grid gap-3">
    <WorkspaceIssues :issues class="rounded-lg border border-default" />
    <WorkspaceIssues :issues="[]" empty="No issues." class="rounded-lg border border-default" />
  </div>
</template>
