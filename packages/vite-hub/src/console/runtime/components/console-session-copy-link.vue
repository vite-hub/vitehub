<script setup lang="ts">
import { CopyButton } from "@vite-hub/ui";

const sessionLink = () => window.location.href;
</script>

<template>
  <UTooltip text="Copy session link">
    <CopyButton :value="sessionLink" size="xs" aria-label="Copy session link">
      <template #icon><UIcon name="i-lucide-link" data-slot="copy-button-icon" /></template>
    </CopyButton>
  </UTooltip>
</template>
