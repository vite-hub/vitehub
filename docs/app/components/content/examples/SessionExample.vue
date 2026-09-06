<script setup lang="ts">
import type { ViteHubUISession } from "@vite-hub/ui";
import type { UIMessage } from "ai";

const session: ViteHubUISession<UIMessage> = {
  id: "session-42",
  title: "Fix the invocation list overflow",
  createdAt: "2026-08-23T09:00:00.000Z",
  messages: [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Fix the error row overflow and update the PR." }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "The layout fix is tested and ready for review." }],
    },
  ],
};
</script>

<template>
  <AgentSession :session="session" status="ready" class="h-96" />
</template>
