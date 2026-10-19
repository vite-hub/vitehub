<script setup lang="ts">
<<<<<<< HEAD
const invocation = {
  id: "inspector-failed-example", traceId: "trace-failed-example", status: "failed",
  title: "Deploy application", agentName: "release-bot", createdAt: "2026-01-01T12:00:00.000Z",
  startedAt: "2026-01-01T12:00:01.000Z", updatedAt: "2026-01-01T12:00:08.000Z", observations: [],
  configuration: { agent: { name: "release-bot", version: "2.0.0" }, tools: [] },
};
</script>
<template><AgentInvocationInspector :invocation="invocation" /></template>
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
  status: "failed",
  title: "Review navigation changes (failed)",
  traceId: "trace_inspector_example",
  updatedAt: "2026-08-30T15:00:14.000Z",
};
</script>

<template>
  <div class="mx-auto h-[36rem] min-w-0 bg-default">
    <AgentInvocationInspector :invocation="invocation" class="h-full border-x border-default" />
  </div>
</template>
>>>>>>> 1fc525c3e1102bd4cb361efe46bd096fe5061afd
