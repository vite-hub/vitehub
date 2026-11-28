<script setup lang="ts">
import type { SidebarMenuSubSlots } from "./types.ts";

defineSlots<SidebarMenuSubSlots>();
</script>

<template>
  <ul data-slot="sidebar-menu-sub"><slot /></ul>
</template>
