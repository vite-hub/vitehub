<script setup lang="ts">
import { X } from "@lucide/vue";
import { DrawerBackdrop, DrawerClose, DrawerContent } from "@ui-sdk/vue/drawer";
import type { SheetContentProps, SheetContentSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
const { closeLabel = "Close" } = defineProps<SheetContentProps>();
defineSlots<SheetContentSlots>();
</script>

<template>
  <DrawerBackdrop>
    <template #render="{ props: part }">
      <div v-bind="part" data-slot="sheet-overlay" />
    </template>
  </DrawerBackdrop>
  <!--
    The content keeps ui-sdk's `drawer-content` slot: ui-sdk handles Escape and the Tab trap only on an element with
    that slot. `data-sheet` scopes the sheet styles to it.
  -->
  <DrawerContent v-bind="$attrs" data-sheet="">
    <slot />
    <!-- An empty `close` slot removes the button. -->
    <slot name="close">
      <DrawerClose :aria-label="closeLabel">
        <template #render="{ props: part, children }">
          <button v-bind="part" data-slot="sheet-close"><component :is="children" /></button>
        </template>
        <X aria-hidden="true" />
      </DrawerClose>
    </slot>
  </DrawerContent>
</template>
