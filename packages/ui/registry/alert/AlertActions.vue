<script setup lang="ts">
import type { AlertActionsSlots } from "./types.ts";

defineSlots<AlertActionsSlots>();
</script>

<template>
  <div data-slot="alert-actions"><slot /></div>
</template>
