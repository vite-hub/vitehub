<script setup lang="ts">
import type { TableCellSlots } from "./types.ts";

defineSlots<TableCellSlots>();
</script>

<template>
  <td data-slot="table-cell"><slot /></td>
</template>
