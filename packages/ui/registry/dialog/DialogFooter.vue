<script setup lang="ts">
import type { DialogFooterSlots } from "./types.ts";

defineSlots<DialogFooterSlots>();
</script>

<template>
  <div data-slot="dialog-footer"><slot /></div>
</template>
