<script setup lang="ts">
const invocation = {
  id: "inspector-failed-example", traceId: "trace-failed-example", status: "failed",
  title: "Deploy application", agentName: "release-bot", createdAt: "2026-01-01T12:00:00.000Z",
  startedAt: "2026-01-01T12:00:01.000Z", updatedAt: "2026-01-01T12:00:08.000Z", observations: [],
  configuration: { agent: { name: "release-bot", version: "2.0.0" }, tools: [] },
};
</script>
<template><AgentInvocationInspector :invocation="invocation" /></template>
