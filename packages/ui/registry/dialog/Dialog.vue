<script setup lang="ts">
import "../core/vitehub.css";
import "./dialog.css";
import { Dialog as DialogRoot } from "@ui-sdk/vue/dialog";
import type { DialogEmits, DialogProps, DialogSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false } = defineProps<DialogProps>();
defineEmits<DialogEmits>();
defineSlots<DialogSlots>();
</script>

<template>
  <DialogRoot v-model:open="open" :default-open="defaultOpen || undefined"><slot /></DialogRoot>
</template>
