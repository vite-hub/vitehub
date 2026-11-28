<script setup lang="ts">
import type { SidebarMenuSlots } from "./types.ts";

defineSlots<SidebarMenuSlots>();
</script>

<template>
  <ul data-slot="sidebar-menu"><slot /></ul>
</template>
