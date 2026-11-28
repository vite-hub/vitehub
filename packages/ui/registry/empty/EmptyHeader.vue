<script setup lang="ts">
import type { EmptyHeaderSlots } from "./types.ts";

defineSlots<EmptyHeaderSlots>();
</script>

<template>
  <div data-slot="empty-header"><slot /></div>
</template>
