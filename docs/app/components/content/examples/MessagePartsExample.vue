<script setup lang="ts">
import type { UIMessage } from "ai";

// SAFETY: Every fixture entry below is a concrete AI SDK UIMessage part variant.
const parts = [
  {
    type: "text",
    text: "I found the failing layout rule and verified the fix.",
  },
  {
    type: "reasoning",
    text: "The virtual list used one fixed height even when an error added another line.",
    state: "done",
  },
  {
    type: "dynamic-tool",
    toolCallId: "tool-1",
    toolName: "run_tests",
    title: "Run focused tests",
    state: "output-available",
    input: { command: "pnpm test invocation-ui" },
    output: { passed: 10 },
  },
  {
    type: "source-url",
    sourceId: "vitehub-ui-docs",
    url: "https://vitehub.dev/docs/ui",
    title: "ViteHub UI documentation",
  },
] as UIMessage["parts"];
</script>

<template>
  <AgentMessageParts :parts="parts" />
</template>
