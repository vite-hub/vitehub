<script setup lang="ts">
import type { SidebarMenuSubItemSlots } from "./types.ts";

defineSlots<SidebarMenuSubItemSlots>();
</script>

<template>
  <li data-slot="sidebar-menu-sub-item"><slot /></li>
</template>
