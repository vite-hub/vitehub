<script setup lang="ts">
import type { FileContents, SelectedLineRange } from "@vite-hub/ui";

const file: FileContents = {
  name: "server/api/orders.get.ts",
  contents: `export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const orders = await kv.get(\`orders:\${user.id}\`)
  return orders ?? []
})
`,
};

// Highlight the KV read. The application owns the selected range.
const selectedLines: SelectedLineRange = { start: 3, end: 3 };
</script>

<template>
  <AgentFile :file="file" :selected-lines="selectedLines" />
</template>
