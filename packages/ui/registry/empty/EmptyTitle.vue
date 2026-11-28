<script setup lang="ts">
import type { EmptyTitleSlots } from "./types.ts";

defineSlots<EmptyTitleSlots>();
</script>

<template>
  <h3 data-slot="empty-title"><slot /></h3>
</template>
