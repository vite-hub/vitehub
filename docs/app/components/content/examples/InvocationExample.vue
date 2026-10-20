<script setup lang="ts">
const invocation = {
  id: "invocation-example", traceId: "trace-invocation-example", status: "completed",
  title: "Review pull request", agentName: "reviewer", createdAt: "2026-01-01T12:00:00.000Z",
  startedAt: "2026-01-01T12:00:01.000Z", updatedAt: "2026-01-01T12:02:00.000Z", observations: [],
};
</script>
<template>
  <div class="h-[34rem] min-w-0"><AgentInvocation :invocation="invocation" class="h-full" /></div>
</template>
