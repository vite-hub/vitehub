<script setup lang="ts">
<<<<<<< HEAD
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
=======
import type { AgentInvocationView } from "vite-hub/console/ui";

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
>>>>>>> 1fc525c3e1102bd4cb361efe46bd096fe5061afd
};
</script>

<template>
<<<<<<< HEAD
  <div class="mx-auto h-[36rem] max-w-3xl">
=======
  <div class="mx-auto h-[36rem] min-w-0 bg-default">
>>>>>>> 1fc525c3e1102bd4cb361efe46bd096fe5061afd
    <AgentInvocationInspector :invocation="invocation" class="h-full border-x border-default" />
  </div>
</template>
