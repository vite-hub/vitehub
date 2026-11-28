<script setup lang="ts">
import type { AlertContentSlots } from "./types.ts";

defineSlots<AlertContentSlots>();
</script>

<template>
  <div data-slot="alert-content"><slot /></div>
</template>
