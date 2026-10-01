<script setup lang="ts">
import type { AgentInvocationListItem } from "@vite-hub/ui";

const now = Date.parse("2026-08-23T12:00:00.000Z");
const items: AgentInvocationListItem[] = [
  { id: "pending", status: "pending", title: "Review queue visibility", updatedAt: "2026-08-23T11:59:40.000Z" },
  {
    id: "running",
    status: "running",
    title: "Polish Console navigation",
    context: "vite-hub/vitehub · PR #1210",
    startedAt: "2026-08-23T11:48:00.000Z",
  },
  { id: "completed", status: "completed", title: "Log breakfast", channel: "telegram", updatedAt: "2026-08-23T09:00:00.000Z" },
  {
    id: "failed",
    status: "failed",
    title: "Fix flaky release job",
    description: "The package registry closed the connection before upload completed.",
    updatedAt: "2026-08-22T15:19:00.000Z",
  },
  {
    id: "cancelled",
    status: "cancelled",
    title: "Investigate provider timeout",
    description: "Cancelled by the user.",
    updatedAt: "2026-08-20T10:00:00.000Z",
  },
];
</script>

<template>
  <AgentInvocationList :items="items" :now="now" aria-label="Sessions by status" class="max-h-96" />
</template>
