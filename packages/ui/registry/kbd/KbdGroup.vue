<script setup lang="ts">
import type { KbdGroupSlots } from "./types.ts";

defineSlots<KbdGroupSlots>();
</script>

<template>
  <kbd data-slot="kbd-group"><slot /></kbd>
</template>
