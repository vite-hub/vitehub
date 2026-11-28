<script setup lang="ts">
import type { CardFooterSlots } from "./types.ts";

defineSlots<CardFooterSlots>();
</script>

<template>
  <div data-slot="card-footer"><slot /></div>
</template>
