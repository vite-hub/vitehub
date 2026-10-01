<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

const invocation: AgentInvocationView = {
  agentName: "release-engineer",
  annotations: {
    "github.pullRequest": 1206,
    "github.repository": "vite-hub/vitehub",
  },
  createdAt: "2026-08-30T15:16:00.000Z",
  error: {
    code: "ECONNRESET",
    message: "The package registry closed the connection before upload completed.",
    name: "Error",
    requestId: "req_release_42",
  },
  failedAt: "2026-08-30T15:19:31.000Z",
  id: "ainv_release_job",
  observations: [
    {
      attributes: {
        "message.content": "Find out why the package release fails after CI succeeds.",
        "message.id": "user-1",
        "message.role": "user",
      },
      name: "agent.message.recorded",
      sequence: 1,
      timestamp: "2026-08-30T15:16:10.000Z",
      trace: { id: "trace_release_job" },
      type: "run",
    },
    {
      attributes: {
        "tool.id": "release-log",
        "tool.name": "Read release log",
        "tool.output": {
          item: {
            aggregatedOutput: "npm ERR! code ECONNRESET\nnpm ERR! network socket hang up",
            command: "gh run view 991842 --log-failed",
            cwd: "/workspace/vitehub",
            exitCode: 1,
          },
        },
      },
      name: "agent.tool.finish",
      sequence: 2,
      timestamp: "2026-08-30T15:18:50.000Z",
      trace: { id: "trace_release_job" },
      type: "run",
    },
    {
      attributes: {
        "error.message": "The package registry closed the connection before upload completed.",
        "vitehub.activity.body": "The run stopped before it could verify a retry.",
      },
      name: "agent.invocation.error",
      sequence: 3,
      timestamp: "2026-08-30T15:19:31.000Z",
      trace: { id: "trace_release_job" },
      type: "error",
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
  <div class="h-[30rem] min-w-0 bg-default">
    <AgentInvocation :invocation="invocation" class="h-full" />
  </div>
</template>
