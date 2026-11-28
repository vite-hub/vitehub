<script setup lang="ts">
import { computed } from "vue";
import type { SidebarMenuButtonProps, SidebarMenuButtonSlots } from "./types.ts";

const { href, isActive = false, size = "md", disabled = false } = defineProps<SidebarMenuButtonProps>();
defineOptions({ inheritAttrs: false });
defineSlots<SidebarMenuButtonSlots>();

const part = computed(() => ({
  "data-slot": "sidebar-menu-button",
  "data-active": isActive ? "" : undefined,
  "data-size": size,
  "aria-current": isActive ? ("page" as const) : undefined,
}));
</script>

<template>
  <slot name="render" :props="{ ...$attrs, ...part, href }">
    <a v-if="href !== undefined && !disabled" v-bind="{ ...$attrs, ...part }" :href="href"><slot /></a>
    <button v-else v-bind="{ ...$attrs, ...part }" type="button" :disabled="disabled || undefined"><slot /></button>
  </slot>
</template>
