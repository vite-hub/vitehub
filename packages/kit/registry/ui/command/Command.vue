<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Command as CommandPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandPart :class="cn('flex size-full flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground', props.class)">
    <slot />
  </CommandPart>
</template>
