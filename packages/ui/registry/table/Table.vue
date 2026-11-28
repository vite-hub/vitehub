<script setup lang="ts">
import "../core/vitehub.css";
import "./table.css";
import type { TableSlots } from "./types.ts";

defineSlots<TableSlots>();
</script>

<template>
  <div data-slot="table-container">
    <table data-slot="table"><slot /></table>
  </div>
</template>
