<script setup lang="ts">
import type { SidebarMenuItemSlots } from "./types.ts";

defineSlots<SidebarMenuItemSlots>();
</script>

<template>
  <li data-slot="sidebar-menu-item"><slot /></li>
</template>
