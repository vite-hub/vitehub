<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Textarea as TextareaPart } from "@ui-sdk/vue/textarea";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <TextareaPart
    auto-resize
    :class="cn('flex min-h-16 max-h-64 w-full min-w-0 resize-none rounded-md border border-input bg-background px-2.5 py-2 text-base text-foreground transition-[border-color,box-shadow] duration-150 outline-none pointer-fine:text-sm placeholder:text-ui-text-dimmed focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive motion-reduce:transition-none', props.class)"
  />
</template>
