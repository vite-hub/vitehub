<script setup lang="ts">
import { MarkdownEditor } from "@vite-hub/ui/markdown-editor";
import { ref } from "vue";

const markdown = ref("# Release notes\n\nSelect text to format it, or type / to add a block.\n");
</script>

<template>
  <ClientOnly>
    <MarkdownEditor v-model="markdown" class="min-h-40" />
  </ClientOnly>
</template>
