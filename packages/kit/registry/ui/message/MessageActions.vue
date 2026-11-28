<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="message-actions" :class="cn('-ms-1.5 flex items-center gap-0.5 text-muted-foreground group-data-[from=user]/message:-me-1.5', props.class)">
    <slot />
  </div>
</template>
