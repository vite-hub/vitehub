<script setup lang="ts">
import type { EmptyDescriptionSlots } from "./types.ts";

defineSlots<EmptyDescriptionSlots>();
</script>

<template>
  <p data-slot="empty-description"><slot /></p>
</template>
