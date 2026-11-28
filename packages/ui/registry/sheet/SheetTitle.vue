<script setup lang="ts">
import { DrawerTitle } from "@ui-sdk/vue/drawer";
import type { SheetTitleSlots } from "./types.ts";

defineSlots<SheetTitleSlots>();
</script>

<template>
  <DrawerTitle>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <h2 v-bind="part" data-slot="sheet-title"><component :is="children" /></h2>
    </template>
    <slot />
  </DrawerTitle>
</template>
