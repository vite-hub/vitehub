<script setup lang="ts">
import { MenuItem } from "@ui-sdk/vue/menu";
import type { DropdownMenuItemSlots, DropdownMenuItemProps } from "./types.ts";
const { value, destructive = false, inset = false, disabled = false } = defineProps<DropdownMenuItemProps>();
defineSlots<DropdownMenuItemSlots>();
</script>

<template>
  <MenuItem :value="value" :destructive="destructive || undefined" :disabled="disabled || undefined" :data-inset="inset ? '' : undefined">
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-item"><component :is="children" /></div>
    </template>
    <slot />
  </MenuItem>
</template>
