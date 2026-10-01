<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";

// Configuration capture was truncated, and one view uses a component outside the read-only catalog.
const invocation: AgentInvocationView = {
  configuration: {
    truncated: true,
    capabilities: [
      {
        id: "billing",
        inspection: {
          label: "Billing",
          view: { root: "chart", elements: { chart: { type: "UsageChart", props: {} } } },
          state: { plan: "team", seats: 12 },
        },
      },
      { id: "orders", inspection: { label: "Orders" } },
    ],
  },
  createdAt: "2026-09-10T09:00:00.000Z",
  id: "ainv_fallbacks",
  observations: [],
  status: "completed",
  traceId: "trace_fallbacks",
  updatedAt: "2026-09-10T09:00:03.000Z",
};
</script>

<template>
  <AgentCapabilityInspector
    :invocation="invocation"
    class="mx-auto max-w-xl rounded-md border border-default bg-default"
  />
</template>
