<script setup lang="ts">
import type { DialogHeaderSlots } from "./types.ts";

defineSlots<DialogHeaderSlots>();
</script>

<template>
  <div data-slot="dialog-header"><slot /></div>
</template>
