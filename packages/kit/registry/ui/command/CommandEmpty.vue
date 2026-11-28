<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandEmpty as CommandEmptyPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandEmptyPart :class="cn('py-6 text-center text-sm text-muted-foreground empty:hidden', props.class)">
    <slot />
  </CommandEmptyPart>
</template>
