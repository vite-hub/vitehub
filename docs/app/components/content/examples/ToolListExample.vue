<script setup lang="ts">
import type { AgentToolInspection } from "@vite-hub/ui";
import { ref } from "vue";

const selected = ref("");
const tools: AgentToolInspection[] = [
  {
    name: "search_meals",
    label: "Searched meals",
    icon: "i-lucide-search",
    description: "Find meals in the food database.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Food name or barcode." },
        limit: { type: "number", description: "Maximum results." },
      },
      required: ["query"],
    },
    outputSchema: { type: "array", items: { type: "object" } },
  },
  {
    name: "log_meal",
    label: "Logged meal",
    icon: "i-lucide-notebook-pen",
    description: "Save a meal to the user's diary.",
    inputSchema: {
      type: "object",
      properties: { mealId: { type: "string" }, grams: { type: "number" } },
      required: ["mealId", "grams"],
    },
  },
  { name: "delete_meal", label: "Deleted meal" },
];
const calls = { search_meals: 3, log_meal: 1 };
</script>

<template>
  <div class="mx-auto max-w-xl space-y-3">
    <AgentToolList
      :tools="tools"
      :calls="calls"
      class="rounded-md border border-default bg-default"
      @select="selected = $event"
    />
    <p class="font-mono text-xs text-muted">select: {{ selected || "none" }}</p>
  </div>
</template>
