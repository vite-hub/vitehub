<script setup lang="ts">
import type { EmptyContentSlots } from "./types.ts";

defineSlots<EmptyContentSlots>();
</script>

<template>
  <div data-slot="empty-content"><slot /></div>
</template>
