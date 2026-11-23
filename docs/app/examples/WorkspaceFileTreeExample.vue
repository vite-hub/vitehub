<script setup lang="ts">
import { WorkspaceFileTree } from "@vite-hub/ui/workspace";
import { ref } from "vue";

const paths = ["astro.config.mjs", "locales/de.json", "locales/es.json", "package.json", "src/components/Greeting.vue", "src/pages/index.astro", "README.md"];
const selected = ref("src/components/Greeting.vue");
const edited = new Set(["locales/es.json", "src/components/Greeting.vue"]);
</script>

<template>
  <div class="mx-auto h-64 max-w-56 overflow-hidden rounded-md border border-default">
    <WorkspaceFileTree v-model:selected="selected" :paths="paths" :edited="edited" />
  </div>
</template>
