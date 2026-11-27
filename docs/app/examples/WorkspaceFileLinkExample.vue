<script setup lang="ts">
import { provideWorkspaceFileOpener, WorkspaceFileLink } from "@vite-hub/ui/workspace";
import { ref } from "vue";

// The workspace gives the opener. Here, the example shows the last path.
const opened = ref("src/app.vue");
provideWorkspaceFileOpener({ show: (path) => { opened.value = path; } });
</script>

<template>
  <div class="grid gap-2 text-sm">
    <p>
      Edit <WorkspaceFileLink path="locales/es.json" />, then <WorkspaceFileLink path="src/components/Greeting.vue" />.
    </p>
    <p class="text-muted">
      Open in the editor: <code>{{ opened }}</code>
    </p>
  </div>
</template>
