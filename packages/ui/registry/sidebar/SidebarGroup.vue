<script setup lang="ts">
import type { SidebarGroupSlots } from "./types.ts";

defineSlots<SidebarGroupSlots>();
</script>

<template>
  <div data-slot="sidebar-group"><slot /></div>
</template>
