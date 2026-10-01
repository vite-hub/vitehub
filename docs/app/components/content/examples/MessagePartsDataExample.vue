<script setup lang="ts">
import type { UIMessage } from "ai";

// SAFETY: The fixture holds one text part and one application-defined `data-deploy` part.
const parts = [
  { type: "text", text: "The preview deploy is live." },
  {
    type: "data-deploy",
    id: "deploy-1",
    data: { environment: "preview", status: "healthy", url: "https://preview.example.com" },
  },
] as UIMessage["parts"];
</script>

<template>
  <AgentMessageParts :parts="parts">
    <template #fallback="{ part }">
      <div
        v-if="part.type === 'data-deploy'"
        class="flex items-center justify-between gap-3 rounded-md border border-default bg-default p-3 text-sm"
      >
        <div>
          <p class="font-medium text-highlighted">{{ part.data.environment }}</p>
          <p class="font-mono text-xs text-muted">{{ part.data.url }}</p>
        </div>
        <UBadge :label="part.data.status" color="neutral" variant="outline" />
      </div>
    </template>
  </AgentMessageParts>
</template>
