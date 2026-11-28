<script setup lang="ts">
import { MenuSub } from "@ui-sdk/vue/menu";
import type { DropdownMenuSubEmits, DropdownMenuSubProps, DropdownMenuSubSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false } = defineProps<DropdownMenuSubProps>();
defineEmits<DropdownMenuSubEmits>();
defineSlots<DropdownMenuSubSlots>();
</script>

<template>
  <MenuSub v-model:open="open" :default-open="defaultOpen || undefined"><slot /></MenuSub>
</template>
