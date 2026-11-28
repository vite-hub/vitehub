<script setup lang="ts">
import type { SheetHeaderSlots } from "./types.ts";

defineSlots<SheetHeaderSlots>();
</script>

<template>
  <div data-slot="sheet-header"><slot /></div>
</template>
