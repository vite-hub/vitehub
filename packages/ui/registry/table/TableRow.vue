<script setup lang="ts">
import type { TableRowSlots } from "./types.ts";

defineSlots<TableRowSlots>();
</script>

<template>
  <tr data-slot="table-row"><slot /></tr>
</template>
