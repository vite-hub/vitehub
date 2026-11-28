<script setup lang="ts">
import { MenuSubContent } from "@ui-sdk/vue/menu";
import type { DropdownMenuSubContentSlots } from "./types.ts";

defineSlots<DropdownMenuSubContentSlots>();
</script>

<template>
  <MenuSubContent>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-sub-content"><component :is="children" /></div>
    </template>
    <slot />
  </MenuSubContent>
</template>
