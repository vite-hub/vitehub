<script setup lang="ts">
import type { TableEmptyProps, TableEmptySlots } from "./types.ts";

const { colspan = 1, label = "No results." } = defineProps<TableEmptyProps>();
defineSlots<TableEmptySlots>();
</script>

<template>
  <tr data-slot="table-empty">
    <td :colspan="colspan"><slot>{{ label }}</slot></td>
  </tr>
</template>
