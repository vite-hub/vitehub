<script setup lang="ts">
import type { SidebarInsetSlots } from "./types.ts";

defineSlots<SidebarInsetSlots>();
</script>

<template>
  <main data-slot="sidebar-inset"><slot /></main>
</template>
