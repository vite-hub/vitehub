<script setup lang="ts">
import { DrawerDescription } from "@ui-sdk/vue/drawer";
import type { SheetDescriptionSlots } from "./types.ts";

defineSlots<SheetDescriptionSlots>();
</script>

<template>
  <DrawerDescription>
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <p v-bind="part" data-slot="sheet-description"><component :is="children" /></p>
    </template>
    <slot />
  </DrawerDescription>
</template>
