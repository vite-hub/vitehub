<script setup lang="ts">
import { MenuContent } from "@ui-sdk/vue/menu";
import type { DropdownMenuContentSlots, DropdownMenuContentProps } from "./types.ts";
const { side = "bottom", align = "start", sideOffset = 4 } = defineProps<DropdownMenuContentProps>();
defineSlots<DropdownMenuContentSlots>();
</script>

<template>
  <MenuContent :side="side" :align="align" :side-offset="sideOffset">
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-content"><component :is="children" /></div>
    </template>
    <slot />
  </MenuContent>
</template>
