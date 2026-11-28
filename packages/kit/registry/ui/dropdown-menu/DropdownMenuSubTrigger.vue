<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { ChevronRightIcon } from "@lucide/vue";
import { MenuSubTrigger } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuSubTrigger :class="cn('relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 data-pending:cursor-progress data-pending:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 w-full border-0 bg-transparent font-normal data-open:bg-accent', props.class)">
    <slot />
    <ChevronRightIcon class="ms-auto text-muted-foreground rtl:rotate-180" aria-hidden="true" />
  </MenuSubTrigger>
</template>
