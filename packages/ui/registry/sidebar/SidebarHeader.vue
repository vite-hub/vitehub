<script setup lang="ts">
import type { SidebarHeaderSlots } from "./types.ts";

defineSlots<SidebarHeaderSlots>();
</script>

<template>
  <div data-slot="sidebar-header"><slot /></div>
</template>
