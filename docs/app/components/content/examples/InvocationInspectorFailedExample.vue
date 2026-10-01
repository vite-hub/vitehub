<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "release-engineer",
  annotations: {
    "github.pullRequest": 1206,
    "github.repository": "vite-hub/vitehub",
  },
  configuration: {
    agent: { name: "release-engineer", version: "2.1.0" },
    capabilities: [{ id: "workspace-shell", metadata: { access: "read" } }],
    driver: { kind: "model", model: { id: "anthropic/claude-sonnet-4.5", provider: "openrouter" } },
    runtime: { name: "node" },
    tools: [{ name: "exec_command", label: "Ran command", icon: "i-lucide-terminal" }],
    workspace: { mode: "read", name: "vitehub", sources: ["repository"] },
  },
  createdAt: "2026-08-30T15:16:00.000Z",
  error: {
    code: "ECONNRESET",
    message: "The package registry closed the connection before upload completed.",
    name: "Error",
  },
  failedAt: "2026-08-30T15:19:31.000Z",
  id: "ainv_release_job",
  observations: [
    {
      attributes: {
        "tool.id": "release-log",
        "tool.name": "exec_command",
        "tool.output": { item: { command: "gh run view 991842 --log-failed", exitCode: 1 } },
      },
      name: "agent.tool.finish",
      sequence: 1,
      timestamp: "2026-08-30T15:18:50.000Z",
      trace: { id: "trace_release_job" },
      type: "run",
    },
  ],
  startedAt: "2026-08-30T15:16:04.000Z",
  status: "failed",
  title: "Fix flaky release job",
  traceId: "trace_release_job",
  updatedAt: "2026-08-30T15:19:31.000Z",
};
</script>

<template>
  <div class="mx-auto h-[36rem] max-w-md bg-default">
    <AgentInvocationInspector :invocation="invocation" class="h-full border-x border-default" />
  </div>
</template>
