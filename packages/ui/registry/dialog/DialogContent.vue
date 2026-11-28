<script setup lang="ts">
import { X } from "@lucide/vue";
import { DialogBackdrop, DialogClose, DialogContent as DialogContentPart } from "@ui-sdk/vue/dialog";
import type { DialogContentProps, DialogContentSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
const { closeLabel = "Close" } = defineProps<DialogContentProps>();
defineSlots<DialogContentSlots>();
</script>

<template>
  <DialogBackdrop data-slot="dialog-backdrop" />
  <DialogContentPart v-bind="$attrs" data-slot="dialog-content">
    <slot />
    <!-- An empty `close` slot removes the button. -->
    <slot name="close">
      <DialogClose data-slot="dialog-close" :aria-label="closeLabel"><X aria-hidden="true" /></DialogClose>
    </slot>
  </DialogContentPart>
</template>
