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
      parts: [
        {
          type: "tool-exec_command",
          toolCallId: "call_1",
          state: "output-available",
          input: { command: "pnpm test invocation-ui" },
          output: "10 tests passed",
        },
        {
          type: "text",
          state: "done",
          text: "Each row now reports its own height. The focused tests pass, and the PR description lists the change.",
        },
      ],
    },
    {
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "Thanks. Leave the PR open for review." }],
    },
  ],
};
</script>

<template>
  <AgentSession :session="session" status="ready" class="h-[30rem]" />
</template>
