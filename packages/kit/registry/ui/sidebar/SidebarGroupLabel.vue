<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="sidebar-group-label" :class="cn('flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-ui-text-dimmed transition-[margin,opacity] duration-200 ease-out group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none', props.class)">
    <slot />
  </div>
</template>
