<script setup lang="ts">
import { Check } from "@lucide/vue";
import { MenuCheckboxItem, MenuItemIndicator } from "@ui-sdk/vue/menu";
import type { DropdownMenuCheckboxItemEmits, DropdownMenuCheckboxItemProps, DropdownMenuCheckboxItemSlots } from "./types.ts";

const checked = defineModel<boolean | undefined>("checked", { default: undefined });
const { value, defaultChecked = false, disabled = false } = defineProps<DropdownMenuCheckboxItemProps>();
defineEmits<DropdownMenuCheckboxItemEmits>();
defineSlots<DropdownMenuCheckboxItemSlots>();
</script>

<template>
  <MenuCheckboxItem v-model:checked="checked" :value="value" :default-checked="defaultChecked || undefined" :disabled="disabled || undefined">
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-checkbox-item"><component :is="children" /></div>
    </template>
    <MenuItemIndicator>
      <template #render="{ props: part, children }">
        <span v-bind="part" data-slot="dropdown-menu-item-indicator"><component :is="children" /></span>
      </template>
      <Check aria-hidden="true" />
    </MenuItemIndicator>
    <slot />
  </MenuCheckboxItem>
</template>
