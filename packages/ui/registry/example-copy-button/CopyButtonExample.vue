<script setup lang="ts">
import { CopyButton } from "../copy-button/index.ts";
</script>

<template>
  <div data-slot="example-copy-button" style="display: flex; align-items: center; gap: 0.5rem">
    <CopyButton value="pnpm add @vite-hub/ui" />
    <CopyButton value="https://vitehub.dev" label="Copy link" variant="outline" />
    <CopyButton value="vitehub deploy" label="Copy" variant="solid" size="md" />
  </div>
</template>
