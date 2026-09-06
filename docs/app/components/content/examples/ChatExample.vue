<script setup lang="ts">
import type { UIMessage } from "ai";

const messages: UIMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Which files changed in the UI package?" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "text",
      text: "The change updates `AgentInvocationList` and adds a regression test for variable-height error rows.",
    }],
  },
];
</script>

<template>
  <AgentChat :messages="messages" status="ready" class="h-96" />
</template>
