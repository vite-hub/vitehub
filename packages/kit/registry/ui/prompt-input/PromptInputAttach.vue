<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { PaperclipIcon } from "@lucide/vue";
import { FileInputTrigger } from "@ui-sdk/vue/file-input";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<{ label?: string; class?: HTMLAttributes["class"] }>(), { label: "Attach files" });
</script>

<template>
  <FileInputTrigger :aria-label="props.label" :class="cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-muted-foreground', props.class)">
    <slot><PaperclipIcon aria-hidden="true" /></slot>
  </FileInputTrigger>
</template>
