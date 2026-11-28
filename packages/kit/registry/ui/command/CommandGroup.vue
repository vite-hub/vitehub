<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandGroup as CommandGroupPart, CommandGroupLabel } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ heading?: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandGroupPart :class="cn('overflow-hidden py-1 text-foreground', props.class)">
    <CommandGroupLabel v-if="props.heading" class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ props.heading }}</CommandGroupLabel>
    <slot />
  </CommandGroupPart>
</template>
