<script setup lang="ts">
import type { EmptyMediaSlots } from "./types.ts";

defineSlots<EmptyMediaSlots>();
</script>

<template>
  <div data-slot="empty-media"><slot /></div>
</template>
