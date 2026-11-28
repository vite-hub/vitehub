<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="prompt-input-toolbar" :class="cn('flex items-center gap-1 p-2 pt-0', props.class)">
    <slot />
  </div>
</template>
