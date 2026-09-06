<script setup lang="ts">
import type { UIMessage } from "ai";

const message: UIMessage = {
  id: "assistant-message",
  role: "assistant",
  parts: [{
    type: "text",
    text: "I checked the current branch. The focused tests pass and the worktree is clean.",
  }],
};
</script>

<template>
  <AgentChatMessage :message="message">
    <template #actions>
      <UButton aria-label="Copy message" icon="i-lucide-copy" color="neutral" variant="ghost" />
    </template>
  </AgentChatMessage>
</template>
