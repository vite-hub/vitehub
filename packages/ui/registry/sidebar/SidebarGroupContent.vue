<script setup lang="ts">
import type { SidebarGroupContentSlots } from "./types.ts";

defineSlots<SidebarGroupContentSlots>();
</script>

<template>
  <div data-slot="sidebar-group-content"><slot /></div>
</template>
