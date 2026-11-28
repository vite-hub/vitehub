<script setup lang="ts">
import "../core/vitehub.css";
import "./card.css";
import type { CardProps, CardSlots } from "./types.ts";

const { variant = "outline" } = defineProps<CardProps>();
defineSlots<CardSlots>();
</script>

<template>
  <div data-slot="card" :data-variant="variant"><slot /></div>
</template>
