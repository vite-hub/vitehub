<script setup lang="ts">
import { TooltipTrigger as TooltipTriggerPart } from "@ui-sdk/vue/tooltip";
import type { TooltipTriggerSlots } from "./types.ts";

defineSlots<TooltipTriggerSlots>();
</script>

<template>
  <TooltipTriggerPart data-slot="tooltip-trigger"><slot /></TooltipTriggerPart>
</template>
