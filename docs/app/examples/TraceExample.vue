<script setup lang="ts">
import type { TraceRunView } from "@vite-hub/ui";

const run: TraceRunView = {
  durationMs: 2_840,
  endTime: "2026-08-23T09:04:12.840Z",
  events: [],
  id: "run_docs_preview",
  startTime: "2026-08-23T09:04:10.000Z",
  status: "completed",
  steps: [
    {
      attributes: { agent: "reviewer", provider: "codex" },
      durationMs: 320,
      endTime: "2026-08-23T09:04:10.320Z",
      events: [],
      id: "step_prepare",
      name: "Prepare Agent invocation",
      startTime: "2026-08-23T09:04:10.000Z",
      status: "completed",
      type: "run",
    },
    {
      attributes: { command: "pnpm test invocation-ui", exitCode: 0 },
      durationMs: 2_520,
      endTime: "2026-08-23T09:04:12.840Z",
      events: [],
      id: "step_verify",
      name: "Run focused tests",
      startTime: "2026-08-23T09:04:10.320Z",
      status: "completed",
      type: "run",
    },
  ],
};
</script>

<template>
  <TraceRun :run="run" default-open>
    <template #title>
      Verification run
    </template>
  </TraceRun>
</template>
