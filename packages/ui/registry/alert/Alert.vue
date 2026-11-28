<script setup lang="ts">
import "../core/vitehub.css";
import "./alert.css";
import type { AlertProps, AlertSlots } from "./types.ts";

const { tone = "neutral", variant = "soft" } = defineProps<AlertProps>();
defineSlots<AlertSlots>();
</script>

<template>
  <div data-slot="alert" :data-tone="tone" :data-variant="variant" :role="tone === 'error' || tone === 'warning' ? 'alert' : 'status'">
    <slot name="icon" />
    <slot />
  </div>
</template>
