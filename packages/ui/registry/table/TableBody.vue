<script setup lang="ts">
import type { TableBodySlots } from "./types.ts";

defineSlots<TableBodySlots>();
</script>

<template>
  <tbody data-slot="table-body"><slot /></tbody>
</template>
