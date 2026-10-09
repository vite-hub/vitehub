<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";
import { ref } from "vue";

const selected = ref<string>();
const trace = { id: "trace_docs_timeline" };

const invocation: AgentInvocationView = {
  agentName: "reviewer",
  completedAt: "2026-08-23T09:04:12.000Z",
  createdAt: "2026-08-23T09:00:00.000Z",
  id: "ainv_docs_timeline",
  observations: [
    {
      attributes: {
        "step.id": "vitehub.workspace.prepare.read-files",
        "vitehub.activity.detail": "2,731 files · 32.0 MB",
        "vitehub.activity.kind": "preparation",
        "vitehub.activity.title": "Reading workspace files",
        "workspace.preparation.durationMs": 13_900,
      },
      name: "vitehub.workspace.prepare.read-files.completed",
      sequence: 1,
      timestamp: "2026-08-23T09:00:02.000Z",
      trace,
      type: "lifecycle",
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
      attributes: { "tool.durationMs": 900, "tool.id": "patch-list", "tool.name": "apply_patch", "tool.output": { item: { changes: [{ path: "/workspace/vitehub/packages/ui/src/components/agent-invocation-list.ts" }], type: "fileChange" } } },
      name: "agent.tool.finish",
      sequence: 3,
      timestamp: "2026-08-23T09:02:10.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "tool.durationMs": 41_200, "tool.id": "run-tests", "tool.name": "exec_command", "tool.output": { item: { aggregatedOutput: "1 test failed\n", command: "pnpm test invocation-ui", exitCode: 1 } } },
      name: "agent.tool.finish",
      sequence: 4,
      timestamp: "2026-08-23T09:02:49.000Z",
      trace,
      type: "run",
    },
    {
      attributes: { "channel.delivery.provider": "github", "channel.effect.content": "Fixed the row height. One test still fails.", "channel.effect.kind": "reply", "tool.durationMs": 640 },
      name: "agent.channel.delivery",
      sequence: 5,
      timestamp: "2026-08-23T09:04:08.000Z",
      trace,
      type: "run",
    },
  ],
  startedAt: "2026-08-23T09:00:00.000Z",
  status: "completed",
  title: "Fix invocation list overflow",
  traceId: "trace_docs_timeline",
  updatedAt: "2026-08-23T09:04:12.000Z",
};
</script>

<template>
  <div class="mx-auto grid max-w-md gap-3">
    <AgentInvocationTimeline :invocation="invocation" @select-activity="selected = $event" />
    <p class="font-mono text-xs text-muted">selected: {{ selected ?? "none" }}</p>
  </div>
</template>
