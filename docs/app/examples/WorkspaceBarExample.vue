<script setup lang="ts">
import { ref } from "vue";
import { WorkspaceBar, WorkspaceExamples, WorkspaceSidebar, type WorkspaceExample } from "@vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "vue", label: "Vue", group: "Source language", description: "A greeting in two languages." },
  { id: "react", label: "React", group: "Source language", description: "The same app, written in JSX." },
  { id: "plurals", label: "Plurals", group: "Recipes", description: "Counts that read right in every locale." },
];
const example = ref("vue");
const sidebar = ref(false);
</script>

<template>
  <div class="relative h-72 overflow-hidden rounded-md border border-default">
    <WorkspaceBar v-model:sidebar="sidebar" sidebar-id="bar-example-sidebar" step="Step 1 of 3">
      <template #examples>
        <WorkspaceExamples v-model="example" :examples />
      </template>
      <template #actions>
        <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-link" label="Copy link" />
      </template>
    </WorkspaceBar>
    <WorkspaceSidebar id="bar-example-sidebar" v-model:open="sidebar">
      <a class="vh-ws-sidebar-link" href="#usage">Usage</a>
      <a class="vh-ws-sidebar-link" href="#accessibility">Accessibility</a>
    </WorkspaceSidebar>
    <p class="p-4 text-sm text-muted">The {{ example }} example is open.</p>
  </div>
</template>
