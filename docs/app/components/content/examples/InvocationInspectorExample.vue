<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "reviewer",
  annotations: {
    "github.pullRequest": 1011,
    "github.repository": "vite-hub/vitehub",
  },
  configuration: {
    agent: { name: "reviewer", version: "1.0.0" },
    capabilities: [{ id: "workspace-shell" }, { id: "pull-request" }],
    driver: { kind: "provider", provider: "codex" },
    instructions: ["Fix the reported issue, verify it, and update the pull request."],
    runtime: { name: "node" },
    tools: [{ name: "exec_command" }, { name: "apply_patch" }],
    workspace: { mode: "write", name: "vitehub", sources: ["repository"] },
  },
  completedAt: "2026-08-23T09:04:12.000Z",
  createdAt: "2026-08-23T09:00:00.000Z",
  id: "ainv_docs_preview",
  observations: [
    {
      attributes: {
        "message.role": "assistant",
        "result.text": "The layout fix is tested and ready for review.",
      },
      name: "agent.message.recorded",
      sequence: 1,
      timestamp: "2026-08-23T09:00:10.000Z",
      trace: { id: "trace_docs_preview" },
      type: "run",
    },
    {
      attributes: { "usage.totalTokens": 12_400 },
      name: "agent.usage.recorded",
      sequence: 2,
      timestamp: "2026-08-23T09:04:00.000Z",
      trace: { id: "trace_docs_preview" },
      type: "run",
    },
  ],
  startedAt: "2026-08-23T09:00:00.000Z",
  status: "completed",
  title: "Fix invocation list overflow",
  traceId: "trace_docs_preview",
  updatedAt: "2026-08-23T09:04:12.000Z",
};
</script>

<template>
  <AgentInvocationInspector
    :invocation="invocation"
    class="mx-auto h-[36rem] max-w-md border-x border-default bg-default"
  />
</template>
