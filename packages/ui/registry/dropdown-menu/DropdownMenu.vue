<script setup lang="ts">
import "../core/vitehub.css";
import "./dropdown-menu.css";
import { Menu } from "@ui-sdk/vue/menu";
import type { DropdownMenuEmits, DropdownMenuProps, DropdownMenuSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false } = defineProps<DropdownMenuProps>();
defineEmits<DropdownMenuEmits>();
defineSlots<DropdownMenuSlots>();
</script>

<template>
  <Menu v-model:open="open" :default-open="defaultOpen || undefined"><slot /></Menu>
</template>
