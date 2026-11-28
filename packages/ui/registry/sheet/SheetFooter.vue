<script setup lang="ts">
import type { SheetFooterSlots } from "./types.ts";

defineSlots<SheetFooterSlots>();
</script>

<template>
  <div data-slot="sheet-footer"><slot /></div>
</template>
