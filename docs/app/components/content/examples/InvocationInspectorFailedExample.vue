<script setup lang="ts">
import { computed } from "vue";
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation = computed<AgentInvocationView>(() => ({
  agentName: "interface-engineer",
  createdAt: new Date(Date.now() - 90_000).toISOString(),
  failedAt: new Date(Date.now() - 10_000).toISOString(),
  id: "ainv_failed_run",
  observations: [],
  error: { message: "The provider could not complete this invocation.", name: "InvocationError" },
  status: "failed",
  title: "Failed Console navigation check",
  traceId: "trace_failed_run",
  updatedAt: new Date(Date.now() - 10_000).toISOString(),
}))
</script>

<template>
  <div class="h-[28rem] min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full" />
  </div>
</template>
