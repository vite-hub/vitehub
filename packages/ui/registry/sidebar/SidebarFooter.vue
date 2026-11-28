<script setup lang="ts">
import type { SidebarFooterSlots } from "./types.ts";

defineSlots<SidebarFooterSlots>();
</script>

<template>
  <div data-slot="sidebar-footer"><slot /></div>
</template>
