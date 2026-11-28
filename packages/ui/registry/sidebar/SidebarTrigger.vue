<script setup lang="ts">
import { PanelLeft } from "@lucide/vue";
import { useSidebar } from "./context.ts";
import type { SidebarTriggerProps, SidebarTriggerSlots } from "./types.ts";

const { label = "Toggle sidebar" } = defineProps<SidebarTriggerProps>();
defineSlots<SidebarTriggerSlots>();
const { collapsed, isMobile, openMobile, toggle } = useSidebar();
</script>

<template>
  <button
    type="button"
    data-slot="sidebar-trigger"
    :aria-label="label"
    aria-keyshortcuts="Control+B Meta+B"
    :aria-expanded="isMobile ? openMobile : !collapsed"
    @click="toggle"
  >
    <slot name="icon"><PanelLeft aria-hidden="true" /></slot>
  </button>
</template>
