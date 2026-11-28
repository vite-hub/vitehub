<script setup lang="ts">
import type { AlertTitleSlots } from "./types.ts";

defineSlots<AlertTitleSlots>();
</script>

<template>
  <p data-slot="alert-title"><slot /></p>
</template>
