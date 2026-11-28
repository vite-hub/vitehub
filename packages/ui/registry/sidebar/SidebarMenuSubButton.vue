<script setup lang="ts">
import { computed } from "vue";
import type { SidebarMenuSubButtonProps, SidebarMenuSubButtonSlots } from "./types.ts";

const { href, isActive = false, disabled = false } = defineProps<SidebarMenuSubButtonProps>();
defineOptions({ inheritAttrs: false });
defineSlots<SidebarMenuSubButtonSlots>();

const part = computed(() => ({
  "data-slot": "sidebar-menu-sub-button",
  "data-active": isActive ? "" : undefined,
  "aria-current": isActive ? ("page" as const) : undefined,
}));
</script>

<template>
  <slot name="render" :props="{ ...$attrs, ...part, href }">
    <a v-if="href !== undefined && !disabled" v-bind="{ ...$attrs, ...part }" :href="href"><slot /></a>
    <button v-else v-bind="{ ...$attrs, ...part }" type="button" :disabled="disabled || undefined"><slot /></button>
  </slot>
</template>
