<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";
import { ref } from "vue";

const open = ref(true);
const invocation: AgentInvocationView = {
  agentName: "support",
  configuration: {
    agent: { name: "support" },
    capabilities: [{ id: "orders" }],
    driver: { kind: "model", model: { id: "gpt-5.6", provider: "openai" } },
    runtime: { name: "cloudflare" },
  },
  completedAt: "2026-08-23T10:00:18.000Z",
  createdAt: "2026-08-23T10:00:00.000Z",
  id: "ainv_refund_question",
  observations: [],
  startedAt: "2026-08-23T10:00:01.000Z",
  status: "completed",
  title: "Answer refund question",
  traceId: "trace_refund_question",
  updatedAt: "2026-08-23T10:00:18.000Z",
  usage: { totalTokens: 3_210, cost: { display: "$0.004", estimated: true } },
};
</script>

<template>
  <div class="mx-auto h-[30rem] max-w-md bg-default">
    <AgentInvocationInspector
      v-if="open"
      :invocation="invocation"
      :show-timeline="false"
      class="h-full border-x border-default"
    >
      <template #actions>
        <UButton
          icon="i-lucide-x"
          aria-label="Close details"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="open = false"
        />
      </template>
      <template #metadata>
        <section class="px-4 py-3 text-xs text-muted">Region: eu-west-1</section>
      </template>
    </AgentInvocationInspector>
    <div v-else class="grid h-full place-items-center border-x border-default">
      <UButton label="Show details" color="neutral" variant="outline" size="sm" @click="open = true" />
    </div>
  </div>
</template>
