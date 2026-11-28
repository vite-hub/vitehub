<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="card-footer" :class="cn('flex items-center gap-2 px-4 [.border-t]:pt-4', props.class)">
    <slot />
  </div>
</template>
