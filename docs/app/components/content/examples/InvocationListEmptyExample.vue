<script setup lang="ts">
import type { AgentInvocationListItem } from "@vite-hub/ui";

const items: AgentInvocationListItem[] = [];
</script>

<template>
  <AgentInvocationList :items="items" aria-label="Empty sessions" class="max-h-60">
    <template #empty>
      <div class="grid place-items-center gap-2 px-4 py-10 text-center">
        <UIcon name="i-ph-chats-circle-light" class="size-6 text-muted" aria-hidden="true" />
        <p class="text-sm font-medium text-highlighted">No sessions yet</p>
        <p class="text-xs text-muted">Run an Agent to see its sessions here.</p>
      </div>
    </template>
  </AgentInvocationList>
</template>
