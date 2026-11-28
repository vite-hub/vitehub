<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Input as InputPart } from "@ui-sdk/vue/input";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <InputPart :class="cn('h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-base text-foreground transition-[border-color,box-shadow] duration-150 outline-none pointer-fine:text-sm placeholder:text-ui-text-dimmed focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive file:border-0 file:bg-transparent file:text-sm file:font-medium motion-reduce:transition-none', props.class)" />
</template>
