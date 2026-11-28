<script setup lang="ts">
import type { TableHeaderSlots } from "./types.ts";

defineSlots<TableHeaderSlots>();
</script>

<template>
  <thead data-slot="table-header"><slot /></thead>
</template>
