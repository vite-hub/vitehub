<script setup lang="ts">
import type { UIMessage } from "ai";

// SAFETY: Every fixture entry below is a concrete AI SDK dynamic tool part in a different state.
const parts = [
  {
    type: "dynamic-tool",
    toolCallId: "tool-running",
    toolName: "run_tests",
    title: "Run focused tests",
    state: "input-available",
    input: { command: "pnpm test invocation-ui" },
  },
  {
    type: "dynamic-tool",
    toolCallId: "tool-done",
    toolName: "read_file",
    title: "Read src/status.ts",
    state: "output-available",
    input: { path: "src/status.ts" },
    output: { lines: 42 },
  },
  {
    type: "dynamic-tool",
    toolCallId: "tool-failed",
    toolName: "deploy_preview",
    title: "Deploy preview",
    state: "output-error",
    input: { branch: "fix/overflow" },
    errorText: "The preview environment quota is exhausted.",
  },
] as UIMessage["parts"];
</script>

<template>
  <AgentMessageParts :parts="parts" />
</template>
