<script setup lang="ts">
import type { UIMessage } from "ai";

const parts: UIMessage["parts"] = [
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
];
</script>

<template>
  <MessageParts :parts="parts" />
</template>
