<script setup lang="ts">
import type { ViteHubUISession } from "@vite-hub/ui";

const session: ViteHubUISession = {
  id: "session-7",
  title: "Production deploy failure",
  updatedAt: "2026-08-23T09:12:00.000Z",
  metadata: { project: "storefront" },
  messages: [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Why did the 09:05 deploy fail?" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "The build ran out of memory while it generated 4,000 pages." }],
    },
  ],
};
</script>

<template>
  <AgentSession :session="session" class="h-96">
    <template #header="{ session: current }">
      <header class="flex items-center justify-between gap-3 border-b border-default px-4 py-3">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold text-highlighted">{{ current.title }}</h2>
          <p class="font-mono text-xs text-muted">{{ current.id }}</p>
        </div>
        <UBadge label="storefront" color="neutral" variant="outline" />
      </header>
    </template>
    <template #footer>
      <p class="border-t border-default px-4 py-3 text-xs text-muted">
        Read-only history. Start a new session to continue.
      </p>
    </template>
  </AgentSession>
</template>
