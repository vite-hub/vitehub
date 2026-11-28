<script setup lang="ts">
import type { CardActionSlots } from "./types.ts";

defineSlots<CardActionSlots>();
</script>

<template>
  <div data-slot="card-action"><slot /></div>
</template>
