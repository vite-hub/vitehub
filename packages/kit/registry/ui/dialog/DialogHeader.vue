<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="dialog-header" :class="cn('flex flex-col gap-1.5 pe-8 text-start', props.class)">
    <slot />
  </div>
</template>
