<script setup lang="ts">
import { DrawerTrigger } from "@ui-sdk/vue/drawer";
import type { SheetTriggerSlots } from "./types.ts";

defineSlots<SheetTriggerSlots>();
</script>

<template>
  <DrawerTrigger>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <button v-bind="part" data-slot="sheet-trigger"><component :is="children" /></button>
    </template>
    <slot />
  </DrawerTrigger>
</template>
