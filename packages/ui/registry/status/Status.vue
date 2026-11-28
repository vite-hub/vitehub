<script setup lang="ts">
import "../core/vitehub.css";
import "./status.css";
import StatusIndicator from "./StatusIndicator.vue";
import StatusLabel from "./StatusLabel.vue";
import type { StatusProps, StatusSlots } from "./types.ts";

const { tone = "neutral", size = "sm", colored = false, pulse = false, label } = defineProps<StatusProps>();
defineSlots<StatusSlots>();
</script>

<template>
  <span data-slot="status" :data-tone="tone" :data-size="size" :data-colored="colored ? '' : undefined" :data-pulse="pulse ? '' : undefined">
    <slot>
      <StatusIndicator />
      <StatusLabel v-if="label">{{ label }}</StatusLabel>
    </slot>
  </span>
</template>
