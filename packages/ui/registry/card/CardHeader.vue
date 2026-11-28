<script setup lang="ts">
import type { CardHeaderSlots } from "./types.ts";

defineSlots<CardHeaderSlots>();
</script>

<template>
  <div data-slot="card-header"><slot /></div>
</template>
