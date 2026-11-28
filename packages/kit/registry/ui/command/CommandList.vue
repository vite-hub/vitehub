<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandList as CommandListPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandListPart :class="cn('max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1', props.class)">
    <slot />
  </CommandListPart>
</template>
