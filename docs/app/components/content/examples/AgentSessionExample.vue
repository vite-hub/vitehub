<script setup lang="ts">
import type { AgentSessionItem, AgentSessionSurface } from "@vite-hub/ui/agent-session";

const surfaces: AgentSessionSurface[] = [
  { id: "files", label: "Files", icon: "i-lucide-files", shortcut: "f" },
];

const items: AgentSessionItem[] = [
  { type: "user", id: "prompt", text: "Add a `/health` route that returns `ok`, with a test." },
  {
    type: "work",
    id: "work",
    label: "Worked for 42s",
    entries: [
      { id: "read", kind: "read", label: "Read", preview: "server/routes/index.ts" },
      { id: "edit", kind: "edit", label: "Edited", preview: "server/routes/health.ts", trailing: "+8" },
      { id: "test", kind: "command", label: "Ran", preview: "pnpm test health", detail: "1 test passed", status: "done" },
    ],
  },
  { type: "assistant", id: "answer", text: "Added `GET /health`. It returns `ok`, and `test/health.test.ts` covers it." },
];

const paths = ["server/routes/index.ts", "server/routes/health.ts", "test/health.test.ts", "package.json"];
</script>

<template>
  <div class="h-[32rem] overflow-hidden rounded-md border border-default bg-default">
    <AgentSession title="Add a health route" :surfaces="surfaces">
      <AgentSessionTimeline :items="items" />
      <template #details>
        <AgentSessionDetailsSection title="Session">
          <AgentSessionDetailsRow icon="i-lucide-circle-check" label="Status" value="Completed" />
          <AgentSessionDetailsRow icon="i-lucide-timer" label="Duration" value="42s" />
          <AgentSessionDetailsRow icon="i-lucide-file-diff" label="Changed files" :value="2" />
        </AgentSessionDetailsSection>
      </template>
      <template #surface-files>
        <FileTree :paths="paths" :options="{ initialExpansion: 'open' }" />
      </template>
    </AgentSession>
  </div>
</template>
