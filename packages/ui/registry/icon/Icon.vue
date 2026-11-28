<script setup lang="ts">
import "../core/vitehub.css";
import "./icon.css";
import type { IconProps, IconSlots } from "./types.ts";

const { size = "md", label } = defineProps<IconProps>();
defineSlots<IconSlots>();
</script>

<template>
  <span data-slot="icon" :data-size="size" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <slot />
  </span>
</template>
