<script setup lang="ts">
const invocation = {
  id: "inspector-compact-example", traceId: "trace-compact-example", status: "running",
  title: "Check repository", agentName: "assistant", createdAt: "2026-01-01T12:00:00.000Z",
  startedAt: "2026-01-01T12:00:01.000Z", updatedAt: "2026-01-01T12:00:10.000Z", observations: [],
  configuration: { agent: { name: "assistant", version: "1.0.0" }, tools: [] },
};
</script>
<template><AgentInvocationInspector :invocation="invocation" :show-timeline="false" /></template>
