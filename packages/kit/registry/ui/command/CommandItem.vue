<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandItem as CommandItemPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandItemPart :class="cn('relative flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 data-pending:cursor-progress data-pending:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground', props.class)">
    <slot />
  </CommandItemPart>
</template>
