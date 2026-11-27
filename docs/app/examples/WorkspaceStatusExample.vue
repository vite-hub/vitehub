<script setup lang="ts">
import { type WorkspaceCursor, WorkspaceEditor, WorkspaceStatus } from "@vite-hub/ui/workspace";
import { ref } from "vue";

const path = "locales/de.json";
const source = ref("{\n  \"welcome\": \"Willkommen zurück\",\n  \"start\": \"Übersetzen\"\n}\n");
const cursor = ref<WorkspaceCursor>({ column: 1, line: 1 });
</script>

<template>
  <div class="mx-auto flex h-48 max-w-md flex-col overflow-hidden rounded-md border border-default">
    <WorkspaceEditor v-model="source" class="min-h-0 flex-1" :path="path" @cursor="cursor = $event" />
    <div class="flex h-6 flex-none items-center gap-3.5 border-t border-default bg-muted px-3 text-[11.5px] text-muted">
      <WorkspaceStatus :cursor="cursor" :path="path" />
    </div>
  </div>
</template>
