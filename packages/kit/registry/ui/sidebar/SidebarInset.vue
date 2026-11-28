<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <main data-slot="sidebar-inset" :class="cn('relative flex min-w-0 w-full flex-1 flex-col bg-background', props.class)">
    <slot />
  </main>
</template>
