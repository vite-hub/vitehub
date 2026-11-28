<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <ul data-slot="sidebar-menu-sub" :class="cn('ms-3.5 flex min-w-0 flex-col gap-0.5 border-s px-2 py-0.5 group-data-[collapsible=icon]:hidden', props.class)">
    <slot />
  </ul>
</template>
