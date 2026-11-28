<script setup lang="ts">
import { DialogDescription as DialogDescriptionPart } from "@ui-sdk/vue/dialog";
import type { DialogDescriptionSlots } from "./types.ts";

defineSlots<DialogDescriptionSlots>();
</script>

<template>
  <DialogDescriptionPart data-slot="dialog-description"><slot /></DialogDescriptionPart>
</template>
