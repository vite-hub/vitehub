<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const configuration: AgentInvocationView["configuration"] = {
  agent: { name: "reviewer", version: "1.0.0" },
  capabilities: [{ id: "workspace-shell", metadata: { access: "write" } }, { id: "pull-request" }],
  driver: { kind: "provider", model: { id: "gpt-5.6", provider: "openai" }, provider: "codex" },
  instructions: ["Fix the reported issue, verify it, and update the pull request."],
  runtime: { name: "node" },
  tools: [{ name: "read_file" }, { name: "exec_command" }, { name: "apply_patch" }],
  workspace: { mode: "write", name: "vitehub", sources: ["repository"] },
};
const trace = { id: "trace_docs_preview" };

// A completed run: the prompt, the recorded work, and the final answer.
const invocation: AgentInvocationView = {
  agentName: "reviewer",
  annotations: {
    "github.pullRequest": 1011,
    "github.repository": "vite-hub/vitehub",
    triggeredBy: "onmax",
  },
  configuration,
  completedAt: "2026-08-23T09:04:12.000Z",
  createdAt: "2026-08-23T09:00:00.000Z",
  id: "ainv_docs_preview",
  observations: [
    {
      attributes: { "vitehub.agent.configuration": configuration },
      name: "vitehub.agent.configured",
      sequence: 1,
      timestamp: "2026-08-23T09:00:01.000Z",
      trace,
      type: "lifecycle",
    },
    {
      attributes: {
        "message.content": "Failed sessions overlap the next row in the invocation list. Fix it and add a regression test.",
        "message.id": "user-1",
        "message.role": "user",
      },
      name: "agent.message.recorded",
      sequence: 2,
      timestamp: "2026-08-23T09:00:05.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "message.content": "The list virtualizes rows with one fixed height. A failed row needs a second line for its error.",
        "message.id": "reasoning-1",
        "message.phase": "reasoning",
        "message.role": "assistant",
        "usage.reasoningTokens": 180,
      },
      name: "agent.message.recorded",
      sequence: 3,
      timestamp: "2026-08-23T09:00:20.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "tool.durationMs": 420,
        "tool.id": "read-list",
        "tool.name": "read_file",
        "tool.input": { path: "packages/ui/src/components/agent-invocation-list.ts" },
        "tool.output": { item: { commandActions: [{ path: "packages/ui/src/components/agent-invocation-list.ts", type: "read" }], cwd: "/workspace/vitehub" } },
      },
      name: "agent.tool.finish",
      sequence: 4,
      timestamp: "2026-08-23T09:00:31.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "tool.durationMs": 900,
        "tool.id": "patch-list",
        "tool.name": "apply_patch",
        "tool.output": {
          item: {
            changes: [{
              diff: "@@ -12,7 +12,9 @@\n-const rowHeight = 56;\n-const offsets = items.map((_, index) => index * rowHeight);\n+const heights = items.map(measureRow);\n+const offsets = heights.map((_, index) =>\n+  heights.slice(0, index).reduce((total, height) => total + height, 0));\n",
              path: "/workspace/vitehub/packages/ui/src/components/agent-invocation-list.ts",
            }],
            type: "fileChange",
          },
        },
      },
      name: "agent.tool.finish",
      sequence: 5,
      timestamp: "2026-08-23T09:02:10.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "message.content": "Rows measure themselves now. Running the focused tests.",
        "message.id": "commentary-1",
        "message.phase": "commentary",
        "message.role": "assistant",
      },
      name: "agent.message.recorded",
      sequence: 6,
      timestamp: "2026-08-23T09:02:15.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "tool.durationMs": 41_200,
        "tool.id": "run-tests",
        "tool.name": "exec_command",
        "tool.output": {
          item: {
            aggregatedOutput: " ✓ test/invocation-ui.test.ts (11 tests) 812ms\n\n Test Files  1 passed (1)\n      Tests  11 passed (11)\n",
            command: "pnpm test invocation-ui",
            cwd: "/workspace/vitehub",
            exitCode: 0,
          },
        },
      },
      name: "agent.tool.finish",
      sequence: 7,
      timestamp: "2026-08-23T09:03:30.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "message.role": "assistant",
        "result.text": "Each row now reports its own height and the list keeps cumulative offsets.\n\n- `agent-invocation-list.ts` measures rows instead of assuming 56px.\n- `invocation-ui.test.ts` renders a failed row with a two-line error and checks the next row's offset.\n\n11 tests pass.",
      },
      name: "agent.message.recorded",
      sequence: 8,
      timestamp: "2026-08-23T09:04:05.000Z",
      trace,
      type: "run",
    },
    {
      attributes: {
        "usage.inputTokens": 31_400,
        "usage.outputTokens": 2_100,
        "usage.reasoningTokens": 180,
        "usage.totalTokens": 33_500,
      },
      name: "agent.usage.recorded",
      sequence: 9,
      timestamp: "2026-08-23T09:04:12.000Z",
      trace,
      type: "lifecycle",
    },
  ],
  startedAt: "2026-08-23T09:00:00.000Z",
  status: "completed",
  title: "Fix invocation list overflow",
  traceId: "trace_docs_preview",
  usage: {
    cost: { display: "$0.12", estimated: true, source: "catalog" },
    inputTokens: 31_400,
    outputTokens: 2_100,
    reasoningTokens: 180,
    totalTokens: 33_500,
  },
  updatedAt: "2026-08-23T09:04:12.000Z",
};
</script>

<template>
  <div class="h-[34rem] min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full" />
  </div>
</template>
