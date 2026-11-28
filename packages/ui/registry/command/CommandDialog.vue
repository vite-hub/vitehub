<script setup lang="ts">
import "../core/vitehub.css";
import "./command.css";
import { Dialog, DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/vue/dialog";
import Command from "./Command.vue";
import type { CommandDialogEmits, CommandDialogProps, CommandDialogSlots } from "./types.ts";

const open = defineModel<boolean | undefined>("open", { default: undefined });
const { defaultOpen = false, title = "Command palette", description = "Search for a command to run." } = defineProps<CommandDialogProps>();
const emit = defineEmits<CommandDialogEmits>();
defineSlots<CommandDialogSlots>();

function run(event: { value: string }) {
  emit("action", event);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open" :default-open="defaultOpen || undefined">
    <slot name="trigger" />
    <DialogBackdrop data-slot="dialog-backdrop" />
    <!-- ui-sdk handles Escape and the Tab trap only on `dialog-content`, so the palette keeps that slot. -->
    <DialogContent data-command-dialog="">
      <!-- ui-sdk writes its own `data-slot` over an attribute. The render slots keep the item's names. -->
      <DialogTitle>
        <template #render="{ props: part }">
          <h2 v-bind="part" data-slot="command-dialog-title">{{ title }}</h2>
        </template>
      </DialogTitle>
      <DialogDescription>
        <template #render="{ props: part }">
          <p v-bind="part" data-slot="command-dialog-description">{{ description }}</p>
        </template>
      </DialogDescription>
      <Command @action="run"><slot /></Command>
    </DialogContent>
  </Dialog>
</template>
