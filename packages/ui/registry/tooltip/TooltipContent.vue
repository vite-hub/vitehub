<script setup lang="ts">
import { TooltipContent as TooltipContentPart } from "@ui-sdk/vue/tooltip";
import type { TooltipContentProps, TooltipContentSlots } from "./types.ts";

const { side = "top", sideOffset = 6 } = defineProps<TooltipContentProps>();
defineSlots<TooltipContentSlots>();
</script>

<template>
  <TooltipContentPart data-slot="tooltip-content" :side="side" :side-offset="sideOffset"><slot /></TooltipContentPart>
</template>
