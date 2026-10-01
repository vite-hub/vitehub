<script setup lang="ts">
import type { AgentInvocationListItem } from "@vite-hub/ui";
import { ref } from "vue";

const selectedId = ref("support");
const items: AgentInvocationListItem[] = [
  {
    id: "support",
    agent: "support",
    project: "storefront",
    provider: "openai",
    status: "running",
    title: "Answer refund question",
    startedAt: "2026-08-23T11:55:00.000Z",
  },
  {
    id: "reviewer",
    agent: "reviewer",
    project: "vitehub",
    provider: "anthropic",
    status: "completed",
    title: "Review queue retries",
    updatedAt: "2026-08-23T10:30:00.000Z",
  },
];
</script>

<template>
  <AgentInvocationList
    :items="items"
    :now="Date.parse('2026-08-23T12:00:00.000Z')"
    :selected-id="selectedId"
    aria-label="Sessions with Agent metadata"
    @select="selectedId = $event.id"
  >
    <template #header="{ items: current }">
      <p class="px-3 pb-2 text-xs font-medium text-muted">{{ current.length }} sessions</p>
    </template>
    <template #projectIcon="{ item }">
      <UIcon
        :name="item.project === 'vitehub' ? 'i-ph-hexagon-light' : 'i-ph-storefront-light'"
        :aria-label="item.project"
      />
    </template>
    <template #harness="{ item }">
      <span class="font-mono">{{ item.agent }}</span>
    </template>
  </AgentInvocationList>
</template>
