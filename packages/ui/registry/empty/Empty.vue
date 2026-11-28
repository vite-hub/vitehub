<script setup lang="ts">
import "../core/vitehub.css";
import "./empty.css";
import type { EmptyProps, EmptySlots } from "./types.ts";

const { size = "md", variant = "ghost" } = defineProps<EmptyProps>();
defineSlots<EmptySlots>();
</script>

<template>
  <div data-slot="empty" :data-size="size" :data-variant="variant"><slot /></div>
</template>
