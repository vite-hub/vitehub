<script setup lang="ts">
import type { CardDescriptionSlots } from "./types.ts";

defineSlots<CardDescriptionSlots>();
</script>

<template>
  <p data-slot="card-description"><slot /></p>
</template>
