<script setup lang="ts">
import "../core/vitehub.css";
import "./bubble.css";
import type { BubbleProps, BubbleSlots } from "./types.ts";

const { align = "start", variant = "solid", tone = "neutral" } = defineProps<BubbleProps>();
defineSlots<BubbleSlots>();
</script>

<template>
  <div data-slot="bubble" :data-align="align" :data-variant="variant" :data-tone="tone"><slot /></div>
</template>
