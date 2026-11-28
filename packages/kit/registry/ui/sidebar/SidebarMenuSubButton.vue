<script setup lang="ts">
import type { Component, HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { sidebarMenuSubButtonVariants } from ".";

const props = withDefaults(defineProps<{ as?: string | Component; isActive?: boolean; class?: HTMLAttributes["class"] }>(), { as: "a" });
</script>

<template>
  <component
    :is="props.as"
    data-slot="sidebar-menu-sub-button"
    data-focus-inset=""
    :data-active="props.isActive ? '' : undefined"
    :aria-current="props.isActive ? 'page' : undefined"
    :type="props.as === 'button' ? 'button' : undefined"
    :class="cn(sidebarMenuSubButtonVariants(), props.class)"
  >
    <slot />
  </component>
</template>
