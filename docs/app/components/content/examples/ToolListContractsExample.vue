<script setup lang="ts">
import type { AgentToolInspection } from "@vite-hub/ui";

// Without `calls`, the list shows tool contracts only, for example a build-time Capability reference.
const tools: AgentToolInspection[] = [
  {
    name: "kv_get",
    description: "Read one value from KV storage.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "Storage key." } },
      required: ["key"],
    },
  },
  {
    name: "mcp_docs_read",
    mcp: { server: "docs", name: "read-doc" },
    description: "Read one documentation page.",
  },
];
</script>

<template>
  <AgentToolList :tools="tools" class="mx-auto max-w-xl rounded-md border border-default bg-default" />
</template>
