<script setup lang="ts">
import type { AgentTrace as AgentTraceComponent } from "@vite-hub/ui";

type TraceRun = InstanceType<typeof AgentTraceComponent>["$props"]["run"];

const run: TraceRun = {
  durationMs: 12_400,
  endTime: "2026-08-30T15:19:31.000Z",
  events: [],
  id: "run_release_job",
  startTime: "2026-08-30T15:19:18.600Z",
  status: "failed",
  steps: [
    {
      attributes: { command: "pnpm build" },
      durationMs: 9_100,
      endTime: "2026-08-30T15:19:27.700Z",
      events: [],
      id: "step_build",
      name: "Build packages",
      startTime: "2026-08-30T15:19:18.600Z",
      status: "completed",
      type: "run",
    },
    {
      attributes: { command: "pnpm publish", exitCode: 1 },
      durationMs: 3_300,
      endTime: "2026-08-30T15:19:31.000Z",
      events: [],
      id: "step_publish",
      name: "Publish to the registry",
      startTime: "2026-08-30T15:19:27.700Z",
      status: "failed",
      type: "run",
    },
  ],
};
</script>

<template>
  <AgentTrace :run="run" :default-open="run.status === 'failed'">
    <template #step="{ step }">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="flex items-center gap-2">
          <UIcon
            :name="step.status === 'failed' ? 'i-lucide-circle-x' : 'i-lucide-circle-check'"
            class="size-4 text-muted"
            aria-hidden="true"
          />
          {{ step.name }}
        </span>
        <code class="text-xs text-muted">{{ step.attributes?.command }}</code>
      </div>
    </template>
  </AgentTrace>
</template>
