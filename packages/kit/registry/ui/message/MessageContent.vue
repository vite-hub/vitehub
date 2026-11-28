<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div
    data-slot="message-content"
    :class="cn('min-w-0 max-w-full text-sm leading-6 text-foreground group-data-[from=user]/message:max-w-[85%] group-data-[from=user]/message:rounded-xl group-data-[from=user]/message:bg-muted group-data-[from=user]/message:px-3.5 group-data-[from=user]/message:py-2 group-data-[from=user]/message:whitespace-pre-wrap group-data-[from=system]/message:text-muted-foreground', props.class)"
  >
    <slot />
  </div>
</template>
