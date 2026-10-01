<script setup lang="ts">
import type { AgentInvocationView } from "@vite-hub/ui";
import { ref } from "vue";

const selectedActivity = ref("");
const invocation: AgentInvocationView = {
  agentName: "product-reviewer",
  configuration: {
    capabilities: [
      {
        id: "mcp",
        inspection: {
          label: "MCP",
          // A read-only JSON Render view. `$state` and `$item` read from the recorded state.
          view: {
            root: "servers",
            elements: {
              servers: {
                type: "Stack",
                props: {},
                repeat: { statePath: "/servers", key: "name" },
                children: ["server"],
              },
              server: {
                type: "Section",
                props: { title: { $item: "/name" } },
                children: ["status", "tools"],
              },
              status: { type: "KeyValue", props: { label: "Discovery", value: { $item: "/status" } } },
              tools: { type: "Tools", props: { mcpServer: { $item: "/name" } } },
            },
          },
          state: {
            servers: [
              { name: "docs", status: "Resolved" },
              { name: "analytics", status: "Skipped" },
            ],
          },
        },
      },
      {
        id: "title",
        inspection: {
          label: "Title",
          view: {
            root: "title",
            elements: {
              title: { type: "Stack", props: {}, children: ["status", "result"] },
              status: { type: "KeyValue", props: { label: "Generation", value: { $state: "/status" } } },
              result: { type: "KeyValue", props: { label: "Title", value: { $state: "/title" } } },
            },
          },
          state: { status: "Completed", title: "Review the docs search results" },
        },
      },
      { id: "workspace-shell", metadata: { access: "read", sandbox: "workspace" } },
    ],
    tools: [
      {
        capabilityId: "mcp",
        name: "mcp_docs_search",
        mcp: { server: "docs", name: "search" },
        description: "Search the documentation index.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Search terms." } },
          required: ["query"],
        },
      },
    ],
  },
  createdAt: "2026-09-10T09:00:00.000Z",
  id: "ainv_capabilities",
  observations: [
    {
      attributes: { "tool.id": "search-1", "tool.name": "mcp_docs_search" },
      name: "agent.tool.finish",
      sequence: 1,
      timestamp: "2026-09-10T09:00:02.000Z",
      trace: { id: "trace_capabilities" },
      type: "run",
    },
  ],
  status: "completed",
  traceId: "trace_capabilities",
  updatedAt: "2026-09-10T09:00:03.000Z",
};
</script>

<template>
  <div class="mx-auto max-w-xl space-y-3">
    <AgentCapabilityInspector
      :invocation="invocation"
      class="rounded-md border border-default bg-default"
      @select-activity="selectedActivity = $event"
    />
    <p class="font-mono text-xs text-muted">selectActivity: {{ selectedActivity || "none" }}</p>
  </div>
</template>
