<script setup lang="ts">
import { MenuTrigger } from "@ui-sdk/vue/menu";
import type { DropdownMenuTriggerSlots } from "./types.ts";

defineSlots<DropdownMenuTriggerSlots>();
</script>

<template>
  <MenuTrigger>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <button v-bind="part" data-slot="dropdown-menu-trigger"><component :is="children" /></button>
    </template>
    <slot />
  </MenuTrigger>
</template>
