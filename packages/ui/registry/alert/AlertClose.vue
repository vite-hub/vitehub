<script setup lang="ts">
import { X } from "@lucide/vue";
import type { AlertCloseEmits, AlertCloseProps, AlertCloseSlots } from "./types.ts";

const { label = "Dismiss" } = defineProps<AlertCloseProps>();
const emit = defineEmits<AlertCloseEmits>();
defineSlots<AlertCloseSlots>();
</script>

<template>
  <button type="button" data-slot="alert-close" :aria-label="label" @click="emit('close')">
    <slot><X aria-hidden="true" /></slot>
  </button>
</template>
