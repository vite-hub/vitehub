<script setup lang="ts">
import type { FileContents } from "@vite-hub/ui";

// Build the markers at runtime so this source file does not contain a literal merge conflict.
const start = "<".repeat(7);
const separator = "=".repeat(7);
const end = ">".repeat(7);
const file: FileContents = {
  name: "src/status.ts",
  contents: `${start} current
export const status = 'running'
${separator}
export const status = 'completed'
${end} incoming
`,
};
</script>

<template>
  <AgentUnresolvedFile :file="file" />
</template>
