<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { DotIcon } from "@lucide/vue";
import { MenuRadioItem, MenuItemIndicator } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ value: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuRadioItem :value="props.value" :class="cn('relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 data-pending:cursor-progress data-pending:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 ps-8', props.class)">
    <span class="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
      <MenuItemIndicator>
        <DotIcon class="size-5 fill-current" aria-hidden="true" />
      </MenuItemIndicator>
    </span>
    <slot />
  </MenuRadioItem>
</template>
