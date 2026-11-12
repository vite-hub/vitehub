<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";

const sessionLink = () => window.location.href;
</script>

<template>
  <UTooltip text="Copy session link">
    <CopyButton :value="sessionLink" icon="i-lucide-link" size="xs" aria-label="Copy session link" />
  </UTooltip>
</template>
