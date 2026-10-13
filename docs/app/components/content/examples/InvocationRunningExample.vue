<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const now = useState("ui-running-clock", () => Date.now());
const time = (secondsAgo: number) => new Date(now.value - secondsAgo * 1_000).toISOString();

const invocation: AgentInvocationView = {
  agentName: "interface-engineer",
  createdAt: time(844),
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
      timestamp: time(836),
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
      timestamp: time(444),
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
      timestamp: time(20),
      trace: { id: "trace_console_navigation" },
      type: "run",
    },
  ],
  startedAt: time(842),
  status: "running",
  title: "Polish Console navigation",
  traceId: "trace_console_navigation",
  updatedAt: time(20),
};
</script>

<template>
  <div class="h-[28rem] min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full" />
  </div>
</template>
