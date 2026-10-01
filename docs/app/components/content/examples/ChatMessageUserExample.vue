<script setup lang="ts">
import type { UIMessage } from "ai";

const message: UIMessage = {
  id: "user-message",
  role: "user",
  parts: [
    { type: "text", text: "Explain this error and propose a fix." },
    {
      type: "file",
      filename: "build.log",
      mediaType: "text/plain",
      url: "data:text/plain,Error%3A%20Cannot%20find%20module",
    },
  ],
};
</script>

<template>
  <AgentChatMessage :message="message">
    <template #header>
      <span class="text-xs text-muted">Sent with 1 attachment</span>
    </template>
  </AgentChatMessage>
</template>
