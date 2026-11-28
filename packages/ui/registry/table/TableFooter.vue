<script setup lang="ts">
import type { TableFooterSlots } from "./types.ts";

defineSlots<TableFooterSlots>();
</script>

<template>
  <tfoot data-slot="table-footer"><slot /></tfoot>
</template>
