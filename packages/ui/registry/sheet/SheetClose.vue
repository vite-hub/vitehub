<script setup lang="ts">
import { DrawerClose } from "@ui-sdk/vue/drawer";
import type { SheetCloseSlots } from "./types.ts";

defineSlots<SheetCloseSlots>();
</script>

<template>
  <DrawerClose>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <button v-bind="part" data-slot="sheet-close"><component :is="children" /></button>
    </template>
    <slot />
  </DrawerClose>
</template>
