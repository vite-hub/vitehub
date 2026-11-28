<script setup lang="ts">
import "../core/vitehub.css";
import "./badge.css";
import type { BadgeProps, BadgeSlots } from "./types.ts";

const { tone = "neutral", variant = "soft", size = "md", label } = defineProps<BadgeProps>();
defineSlots<BadgeSlots>();
</script>

<template>
  <span data-slot="badge" :data-tone="tone" :data-variant="variant" :data-size="size">
    <slot name="icon" />
    <slot>{{ label }}</slot>
  </span>
</template>
