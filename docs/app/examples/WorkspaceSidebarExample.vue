<script setup lang="ts">
import { ref } from "vue";
import { WorkspaceBar, WorkspaceSidebar } from "@vite-hub/ui/workspace";

const open = ref(false);
const copied = ref(false);
const last = ref("nothing yet");

function copy() {
  last.value = "Copy link";
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <div class="relative h-80 overflow-hidden rounded-md border border-default">
    <WorkspaceBar v-model:sidebar="open" sidebar-id="sidebar-example" />
    <WorkspaceSidebar
      id="sidebar-example"
      v-model:open="open"
      :copied
      @reset="last = 'Reset'"
      @download="last = 'Download'"
      @copy-link="copy"
    >
      <p class="vh-ws-sidebar-heading">Guide</p>
      <a class="vh-ws-sidebar-link" href="#installation">Installation</a>
      <a class="vh-ws-sidebar-link" href="#usage">Usage</a>
    </WorkspaceSidebar>
    <p class="p-4 text-sm text-muted">Last action: {{ last }}</p>
  </div>
</template>
