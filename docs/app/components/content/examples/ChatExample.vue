<script setup lang="ts">
import type { UIMessage } from "ai";

// A short exchange with a tool call, as `useChat()` would hold it after two turns.
const messages: UIMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Why do failed sessions overlap in the invocation list?" }],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        state: "done",
        text: "The list virtualizes rows with one fixed height. A failed row adds an error line, so it needs more space.",
      },
      {
        type: "tool-read_file",
        toolCallId: "call_1",
        state: "output-available",
        input: { path: "packages/ui/src/components/agent-invocation-list.ts" },
        output: "const rowHeight = 56;\nconst offsets = items.map((_, index) => index * rowHeight);",
      },
      {
        type: "text",
        state: "done",
        text: "The list uses one fixed row height of 56px. A failed row renders a second line for its error, so the next row overlaps it.\n\nEach row should report its own height, and the list should keep cumulative offsets.",
      },
    ],
  },
  {
    id: "user-2",
    role: "user",
    parts: [{ type: "text", text: "Fix it and add a regression test." }],
  },
  {
    id: "assistant-2",
    role: "assistant",
    parts: [
      {
        type: "tool-apply_patch",
        toolCallId: "call_2",
        state: "output-available",
        input: { files: ["agent-invocation-list.ts", "invocation-ui.test.ts"] },
        output: { changed: 2 },
      },
      {
        type: "text",
        state: "done",
        text: "Done. `AgentInvocationList` now measures each row, and `invocation-ui.test.ts` covers a failed row with a two-line error.",
      },
    ],
  },
];
</script>

<template>
  <AgentChat :messages="messages" status="ready" class="h-[28rem]" />
</template>
