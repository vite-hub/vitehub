<script setup lang="ts">
import type { CardContentSlots } from "./types.ts";

defineSlots<CardContentSlots>();
</script>

<template>
  <div data-slot="card-content"><slot /></div>
</template>
