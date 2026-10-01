<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "queue-reviewer",
  createdAt: "2026-08-30T18:00:00.000Z",
  id: "ainv_queue_visibility",
  observations: [],
  status: "pending",
  title: "Review queue visibility",
  traceId: "trace_queue_visibility",
  updatedAt: "2026-08-30T18:00:00.000Z",
};
</script>

<template>
  <div class="h-64 min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full">
      <template #title="{ invocation: current }">
        {{ current.title }} <span class="font-normal text-muted">(queued)</span>
      </template>
      <template #actions>
        <UButton label="Cancel" color="neutral" variant="outline" size="xs" />
      </template>
    </AgentInvocation>
  </div>
</template>
