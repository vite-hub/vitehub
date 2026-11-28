<script setup lang="ts">
import type { DropdownMenuLabelProps, DropdownMenuLabelSlots } from "./types.ts";

const { inset = false } = defineProps<DropdownMenuLabelProps>();
defineSlots<DropdownMenuLabelSlots>();
</script>

<template>
  <!-- A heading outside a group. A group's own label is the `label` of `DropdownMenuGroup`, which names the group. -->
  <div data-slot="dropdown-menu-label" role="presentation" :data-inset="inset ? '' : undefined"><slot /></div>
</template>
