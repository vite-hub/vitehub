<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { MenuSubContent as MenuSubContentPart } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuSubContentPart :class="cn('z-50 m-0 max-h-(--available-height) min-w-40 overflow-y-auto overscroll-contain rounded-xl border-0 bg-popover p-1 text-sm text-popover-foreground shadow-popover outline-none backdrop-blur-xl origin-(--transform-origin) data-[presentation=sheet]:w-full data-[presentation=sheet]:max-w-none data-[presentation=sheet]:rounded-b-none data-[presentation=sheet]:pb-[max(0.25rem,env(safe-area-inset-bottom))]', props.class)">
    <slot />
  </MenuSubContentPart>
</template>
