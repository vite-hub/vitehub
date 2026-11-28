<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { MenuItem } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ variant?: "default" | "destructive"; inset?: boolean; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuItem
    :data-variant="props.variant ?? 'default'"
    :data-inset="props.inset ? '' : undefined"
    :class="cn('relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 data-pending:cursor-progress data-pending:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4 data-inset:ps-8 data-[variant=destructive]:text-vh-text-error', props.class)"
  >
    <slot />
  </MenuItem>
</template>
