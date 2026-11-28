<script setup lang="ts">
import { Circle } from "@lucide/vue";
import { MenuItemIndicator, MenuRadioItem } from "@ui-sdk/vue/menu";
import type { DropdownMenuRadioItemProps, DropdownMenuRadioItemSlots } from "./types.ts";

const { value, disabled = false } = defineProps<DropdownMenuRadioItemProps>();
defineSlots<DropdownMenuRadioItemSlots>();
</script>

<template>
  <MenuRadioItem :value="value" :disabled="disabled || undefined">
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-radio-item"><component :is="children" /></div>
    </template>
    <MenuItemIndicator>
      <template #render="{ props: part, children }">
        <span v-bind="part" data-slot="dropdown-menu-item-indicator"><component :is="children" /></span>
      </template>
      <Circle data-slot="dropdown-menu-radio-dot" aria-hidden="true" />
    </MenuItemIndicator>
    <slot />
  </MenuRadioItem>
</template>
