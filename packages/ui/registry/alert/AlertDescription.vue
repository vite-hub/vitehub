<script setup lang="ts">
import type { AlertDescriptionSlots } from "./types.ts";

defineSlots<AlertDescriptionSlots>();
</script>

<template>
  <div data-slot="alert-description"><slot /></div>
</template>
