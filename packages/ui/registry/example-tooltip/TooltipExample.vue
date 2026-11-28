<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip/index.ts";
import { Settings } from "@lucide/vue";
</script>

<template>
  <div data-slot="example-tooltip" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Tooltip label="Deploy the main branch">
      <TooltipTrigger>Deploy</TooltipTrigger>
    </Tooltip>
    <Tooltip :delay="0">
      <TooltipTrigger aria-label="Settings"><Settings aria-hidden="true" /></TooltipTrigger>
      <TooltipContent side="bottom">Settings</TooltipContent>
    </Tooltip>
  </div>
</template>
