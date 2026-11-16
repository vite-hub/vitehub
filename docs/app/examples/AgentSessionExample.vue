<script setup lang="ts">
import { AgentSession, AgentSessionDetailsRow, AgentSessionDetailsSection, AgentSessionTimeline } from "@vite-hub/ui";
import type { AgentSessionItem, AgentSessionSurface } from "@vite-hub/ui";

const surfaces: AgentSessionSurface[] = [{ id: "trace", label: "Trace", icon: "i-lucide-list-tree", shortcut: "t" }];
const items: AgentSessionItem[] = [
  { id: "prompt", type: "user", text: "Update the Workspace guide." },
  { id: "work", type: "work", entries: [{ id: "edit", kind: "edit", label: "docs/workspace.md", status: "done", detail: "Added the retained revision example." }] },
  { id: "answer", type: "assistant", text: "The guide now shows how to open the revision that a session used." },
];
</script>

<template>
  <AgentSession title="Update the Workspace guide" :surfaces="surfaces" class="h-[30rem]">
    <AgentSessionTimeline :items="items" />
    <template #details>
      <AgentSessionDetailsSection title="Session">
        <AgentSessionDetailsRow icon="i-lucide-circle-check" label="Status" value="Completed" />
        <AgentSessionDetailsRow icon="i-lucide-timer" label="Duration" value="24s" />
      </AgentSessionDetailsSection>
    </template>
    <template #surface-trace>
      <p class="p-4 text-sm text-muted">Read the guide, added an example, and checked the links.</p>
    </template>
  </AgentSession>
</template>
