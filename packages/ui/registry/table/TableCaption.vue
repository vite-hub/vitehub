<script setup lang="ts">
import type { TableCaptionSlots } from "./types.ts";

defineSlots<TableCaptionSlots>();
</script>

<template>
  <caption data-slot="table-caption"><slot /></caption>
</template>
