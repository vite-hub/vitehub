<script setup lang="ts">
import type { CardTitleSlots } from "./types.ts";

defineSlots<CardTitleSlots>();
</script>

<template>
  <h3 data-slot="card-title"><slot /></h3>
</template>
