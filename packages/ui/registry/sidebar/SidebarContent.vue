<script setup lang="ts">
import type { SidebarContentSlots } from "./types.ts";

defineSlots<SidebarContentSlots>();
</script>

<template>
  <div data-slot="sidebar-content"><slot /></div>
</template>
