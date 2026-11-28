<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="dropdown-menu-label" :class="cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', props.class)">
    <slot />
  </div>
</template>
