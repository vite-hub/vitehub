<script setup lang="ts">
import "../core/vitehub.css";
import "./tooltip.css";
import { Tooltip as TooltipRoot } from "@ui-sdk/vue/tooltip";
import TooltipContent from "./TooltipContent.vue";
import type { TooltipEmits, TooltipProps, TooltipSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false, delay, label } = defineProps<TooltipProps>();
defineEmits<TooltipEmits>();
defineSlots<TooltipSlots>();
</script>

<template>
  <TooltipRoot v-model:open="open" :default-open="defaultOpen || undefined" :delay="delay">
    <slot />
    <TooltipContent v-if="label">{{ label }}</TooltipContent>
  </TooltipRoot>
</template>
