<script setup lang="ts">
import { DialogClose as DialogClosePart } from "@ui-sdk/vue/dialog";
import type { DialogCloseSlots } from "./types.ts";

defineSlots<DialogCloseSlots>();
</script>

<template>
  <DialogClosePart data-slot="dialog-close"><slot /></DialogClosePart>
</template>
