<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const trace = { id: "trace_docs_preview" };

// The record of a completed run, with the configuration that the run captured.
const invocation: AgentInvocationView = {
  agentName: "reviewer",
  annotations: {
    "github.pullRequest": 1011,
    "github.repository": "vite-hub/vitehub",
    triggeredBy: "onmax",
  },
  configuration: {
    agent: { name: "reviewer", version: "1.0.0" },
    capabilities: [
      { id: "workspace-shell", metadata: { access: "write", sandbox: "workspace" } },
      { id: "pull-request" },
    ],
    channels: [{ id: "github", kind: "github" }],
    driver: { kind: "provider", model: { id: "gpt-5.6", provider: "openai" }, provider: "codex" },
    instructions: ["Fix the reported issue, verify it, and update the pull request."],
    runtime: { name: "node" },
    tools: [
      { name: "read_file", label: "Read file", icon: "i-lucide-eye", description: "Read one file from the Workspace." },
      { name: "exec_command", label: "Ran command", icon: "i-lucide-terminal", description: "Run a shell command in the Workspace." },
      { name: "apply_patch", label: "Changed files", icon: "i-lucide-square-pen", description: "Apply a unified diff to the Workspace." },
      { name: "web_search", label: "Searched the web", icon: "i-lucide-globe" },
    ],
    workspace: { mode: "write", name: "vitehub", sources: ["gh:vite-hub/vitehub", "pull-request"] },
  },
  completedAt: "2026-08-23T09:04:12.000Z",
  createdAt: "2026-08-23T09:00:00.000Z",
  id: "ainv_docs_preview",
  observations: [
    {
      attributes: { "message.content": "Fix the error row overflow and add a regression test.", "message.id": "user-1", "message.role": "user" },
      name: "agent.message.recorded",
      sequence: 1,
      timestamp: "2026-08-23T09:00:05.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "tool.durationMs": 420, "tool.id": "read-list", "tool.name": "read_file", "tool.input": { path: "packages/ui/src/components/agent-invocation-list.ts" } },
      name: "agent.tool.finish",
      sequence: 2,
      timestamp: "2026-08-23T09:00:31.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "tool.durationMs": 900, "tool.id": "patch-list", "tool.name": "apply_patch", "tool.output": { item: { changes: [{ diff: "@@ -12 +12 @@\n-const rowHeight = 56;\n+const heights = items.map(measureRow);\n", path: "/workspace/vitehub/packages/ui/src/components/agent-invocation-list.ts" }], type: "fileChange" } } },
      name: "agent.tool.finish",
      sequence: 3,
      timestamp: "2026-08-23T09:02:10.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "tool.durationMs": 41_200, "tool.id": "run-tests", "tool.name": "exec_command", "tool.output": { item: { aggregatedOutput: "11 tests passed\n", command: "pnpm test invocation-ui", exitCode: 0 } } },
      name: "agent.tool.finish",
      sequence: 4,
      timestamp: "2026-08-23T09:03:30.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "message.role": "assistant", "result.text": "Each row now reports its own height. 11 tests pass." },
      name: "agent.message.recorded",
      sequence: 5,
      timestamp: "2026-08-23T09:04:05.000Z",
      trace,
      type: "run",
    },
  ],
  startedAt: "2026-08-23T09:00:00.000Z",
  status: "completed",
  title: "Fix invocation list overflow",
  traceId: "trace_docs_preview",
  updatedAt: "2026-08-23T09:04:12.000Z",
  usage: {
    cachedInputTokens: 18_200,
    cost: { display: "$0.12", estimated: true },
    inputTokens: 31_400,
    outputTokens: 2_100,
    reasoningTokens: 180,
    totalTokens: 33_500,
  },
};
</script>

<template>
  <div class="mx-auto h-[36rem] max-w-md bg-default">
    <AgentInvocationInspector :invocation="invocation" class="h-full border-x border-default" />
  </div>
</template>
