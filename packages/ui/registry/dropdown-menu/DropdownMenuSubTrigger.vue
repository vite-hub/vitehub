<script setup lang="ts">
import { MenuSubTrigger } from "@ui-sdk/vue/menu";
import type { DropdownMenuSubTriggerSlots, DropdownMenuSubTriggerProps } from "./types.ts";
import { ChevronRight } from "@lucide/vue";
const { inset = false, disabled = false } = defineProps<DropdownMenuSubTriggerProps>();
defineSlots<DropdownMenuSubTriggerSlots>();
</script>

<template>
  <MenuSubTrigger :disabled="disabled || undefined" :data-inset="inset ? '' : undefined">
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-sub-trigger"><component :is="children" /></div>
    </template>
    <slot />
    <ChevronRight data-slot="dropdown-menu-sub-icon" aria-hidden="true" />
  </MenuSubTrigger>
</template>
