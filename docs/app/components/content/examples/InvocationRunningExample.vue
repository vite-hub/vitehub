<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "interface-engineer",
  createdAt: "2026-08-30T17:25:00.000Z",
  id: "ainv_console_navigation",
  observations: [
    {
      attributes: {
        "message.content": "Tighten the Console navigation spacing at mobile widths.",
        "message.id": "user-1",
        "message.role": "user",
      },
      name: "agent.message.recorded",
      sequence: 1,
      timestamp: "2026-08-30T17:25:08.000Z",
      trace: { id: "trace_console_navigation" },
      type: "run",
    },
    {
      attributes: {
        "progress.label": "Comparing the primitive pages",
        "progress.value": 0.62,
        "vitehub.activity.body": "Checking the navigation rhythm at desktop and mobile widths.",
      },
      name: "agent.progress",
      sequence: 2,
      timestamp: "2026-08-30T17:31:40.000Z",
      trace: { id: "trace_console_navigation" },
      type: "run",
    },
    {
      attributes: {
        "tool.id": "browser-check",
        "tool.name": "Check responsive layout",
        "tool.output": { route: "/_vitehub/agents/interface-engineer", viewport: "390x844" },
      },
      name: "agent.tool.finish",
      sequence: 3,
      timestamp: "2026-08-30T17:38:44.000Z",
      trace: { id: "trace_console_navigation" },
      type: "run",
    },
  ],
  startedAt: "2026-08-30T17:25:02.000Z",
  status: "running",
  title: "Polish Console navigation",
  traceId: "trace_console_navigation",
  updatedAt: "2026-08-30T17:38:44.000Z",
};
</script>

<template>
  <div class="h-[28rem] min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full" />
  </div>
</template>
