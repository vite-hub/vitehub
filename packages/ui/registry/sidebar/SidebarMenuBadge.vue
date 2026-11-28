<script setup lang="ts">
import type { SidebarMenuBadgeSlots } from "./types.ts";

defineSlots<SidebarMenuBadgeSlots>();
</script>

<template>
  <div data-slot="sidebar-menu-badge"><slot /></div>
</template>
