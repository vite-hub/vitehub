<script setup lang="ts">
const invocation = {
  id: "inspector-example",
  traceId: "trace-inspector-example",
  status: "completed",
  title: "Review pull request",
  agentName: "reviewer",
  createdAt: "2026-01-01T12:00:00.000Z",
  startedAt: "2026-01-01T12:00:01.000Z",
  updatedAt: "2026-01-01T12:02:00.000Z",
  observations: [],
  configuration: { agent: { name: "reviewer", version: "1.0.0" }, tools: [] },
};
</script>

<template>
  <div class="mx-auto h-[36rem] max-w-3xl">
    <AgentInvocationInspector :invocation="invocation" class="h-full border-x border-default" />
  </div>
</template>
