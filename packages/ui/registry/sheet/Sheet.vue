<script setup lang="ts">
import "../core/vitehub.css";
import "./sheet.css";
import { Drawer } from "@ui-sdk/vue/drawer";
import type { SheetEmits, SheetProps, SheetSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false, side = "right" } = defineProps<SheetProps>();
defineEmits<SheetEmits>();
defineSlots<SheetSlots>();
</script>

<template>
  <Drawer v-model:open="open" :default-open="defaultOpen || undefined" :side="side"><slot /></Drawer>
</template>
