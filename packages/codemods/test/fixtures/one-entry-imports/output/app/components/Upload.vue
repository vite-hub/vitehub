<script setup lang="ts">
import { detectContentType } from "vite-hub/blob/client"

defineProps<{ bytes: Uint8Array }>()
</script>

<template>
  <span>{{ detectContentType(bytes) }}</span>
</template>
