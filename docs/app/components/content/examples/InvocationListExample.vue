<script setup lang="ts">
import type { AgentInvocationListItem } from "@vite-hub/ui";
import { ref } from "vue";

const selectedId = ref("invocation-ui");
const items: AgentInvocationListItem[] = [
  {
    id: "invocation-ui",
    project: "vitehub",
    context: "vite-hub/vitehub · PR #1667",
    provider: "claude",
    status: "running",
    title: "Polish the Console UI defaults",
    updatedAt: "2026-08-23T09:18:00.000Z",
  },
  {
    id: "invocation-completed",
    project: "vitehub",
    context: "vite-hub/vitehub · PR #1012",
    provider: "codex",
    status: "completed",
    title: "fix(agent): keep the trace readable",
    updatedAt: "2026-08-23T09:04:00.000Z",
  },
  {
    id: "invocation-failed",
    project: "vitehub",
    context: "vite-hub/vitehub · PR #1015",
    description: "The operation was aborted due to timeout.",
    provider: "codex",
    status: "failed",
    title: "feat(console): inspect Agent runs",
    updatedAt: "2026-08-23T08:42:00.000Z",
  },
];
</script>

<template>
  <AgentInvocationList
    :items="items"
    :now="Date.parse('2026-08-23T09:20:00.000Z')"
    :selected-id="selectedId"
    aria-label="Example Agent sessions"
    class="max-h-80"
    @select="selectedId = $event.id"
  />
</template>
