<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { TabsTab as TabsTabPart } from "@ui-sdk/vue/tabs";
import { cn } from "@/lib/utils";

const props = defineProps<{ value: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <TabsTabPart :value="props.value" :class="cn('relative inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent px-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-selected:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-[orientation=vertical]:justify-start [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4', props.class)">
    <slot />
  </TabsTabPart>
</template>
