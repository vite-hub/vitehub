<script setup lang="ts">
import type { TableHeadSlots } from "./types.ts";

defineSlots<TableHeadSlots>();
</script>

<template>
  <th data-slot="table-head" scope="col"><slot /></th>
</template>
