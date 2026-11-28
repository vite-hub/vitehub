<script setup lang="ts">
import { MenuRadioGroup } from "@ui-sdk/vue/menu";
import type { DropdownMenuRadioGroupEmits, DropdownMenuRadioGroupProps, DropdownMenuRadioGroupSlots } from "./types.ts";

const model = defineModel<string>();
const { defaultValue } = defineProps<DropdownMenuRadioGroupProps>();
defineEmits<DropdownMenuRadioGroupEmits>();
defineSlots<DropdownMenuRadioGroupSlots>();
</script>

<template>
  <MenuRadioGroup v-model:value="model" :default-value="defaultValue">
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="dropdown-menu-radio-group"><component :is="children" /></div>
    </template>
    <slot />
  </MenuRadioGroup>
</template>
