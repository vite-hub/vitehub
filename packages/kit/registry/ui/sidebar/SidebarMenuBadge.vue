<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="sidebar-menu-badge" :class="cn('pointer-events-none absolute end-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-muted-foreground tabular-nums select-none group-data-[collapsible=icon]:hidden', props.class)">
    <slot />
  </div>
</template>
