<script setup lang="ts">
import type { SidebarGroupLabelProps, SidebarGroupLabelSlots } from "./types.ts";

const { label } = defineProps<SidebarGroupLabelProps>();
defineSlots<SidebarGroupLabelSlots>();
</script>

<template>
  <div data-slot="sidebar-group-label"><slot>{{ label }}</slot></div>
</template>
