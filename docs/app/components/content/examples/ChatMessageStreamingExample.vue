<script setup lang="ts">
import type { UIMessage } from "ai";

const message: UIMessage = {
  id: "assistant-streaming",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "Find the root cause before proposing a fix.", state: "streaming" },
    { type: "text", text: "The queue consumer retries the job, but the lock", state: "streaming" },
  ],
};
</script>

<template>
  <AgentChatMessage :message="message" streaming>
    <template #leading>
      <UAvatar icon="i-lucide-bot" alt="Agent" size="sm" />
    </template>
  </AgentChatMessage>
</template>
