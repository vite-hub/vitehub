<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { TabsPanel as TabsPanelPart } from "@ui-sdk/vue/tabs";
import { cn } from "@/lib/utils";

const props = defineProps<{ value: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <TabsPanelPart :value="props.value" :class="cn('flex-1 pt-4 text-sm data-[orientation=vertical]:pt-0 data-[orientation=vertical]:ps-4', props.class)">
    <slot />
  </TabsPanelPart>
</template>
