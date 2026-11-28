<script setup lang="ts">
import { MenuGroup, MenuGroupLabel } from "@ui-sdk/vue/menu";
import type { DropdownMenuGroupProps, DropdownMenuGroupSlots } from "./types.ts";

const { label } = defineProps<DropdownMenuGroupProps>();
defineSlots<DropdownMenuGroupSlots>();
</script>

<template>
  <MenuGroup>
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-group"><component :is="children" /></div>
    </template>
    <MenuGroupLabel v-if="label">
      <template #render="{ props: part, children }">
        <div v-bind="part" data-slot="dropdown-menu-label"><component :is="children" /></div>
      </template>
      {{ label }}
    </MenuGroupLabel>
    <slot />
  </MenuGroup>
</template>
