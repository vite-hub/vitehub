<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "reviewer",
  configuration: {
    agent: { name: "reviewer", version: "1.0.0" },
    driver: { kind: "provider", model: { id: "gpt-5.6", provider: "openai" }, provider: "codex" },
    runtime: { name: "node" },
    tools: [{ name: "exec_command", label: "Run command", icon: "i-lucide-terminal" }],
    workspace: { mode: "write", name: "vitehub", sources: ["repository"] },
  },
  createdAt: "2026-08-30T15:00:00.000Z",
  id: "ainv_inspector_example",
  observations: [
    { attributes: { "message.content": "Review the navigation changes.", "message.role": "user" }, name: "agent.message.recorded", sequence: 1, timestamp: "2026-08-30T15:00:01.000Z", trace: { id: "trace_inspector_example" }, type: "run" },
    { attributes: { "tool.name": "exec_command", "tool.output": { exitCode: 0, command: "pnpm test" } }, name: "agent.tool.finish", sequence: 2, timestamp: "2026-08-30T15:00:12.000Z", trace: { id: "trace_inspector_example" }, type: "run" },
  ],
  startedAt: "2026-08-30T15:00:01.000Z",
  status: "completed",
  title: "Review navigation changes",
  traceId: "trace_inspector_example",
  updatedAt: "2026-08-30T15:00:14.000Z",
};
</script>

<template>
  <div class="mx-auto h-[36rem] min-w-0 bg-default">
    <AgentInvocationInspector :invocation="invocation" :show-timeline="false" show-capabilities class="h-full border-x border-default" />
  </div>
</template>
