<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <h3 data-slot="empty-title" :class="cn('text-sm font-semibold', props.class)">
    <slot />
  </h3>
</template>
