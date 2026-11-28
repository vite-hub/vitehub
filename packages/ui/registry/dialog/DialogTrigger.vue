<script setup lang="ts">
import { DialogTrigger as DialogTriggerPart } from "@ui-sdk/vue/dialog";
import type { DialogTriggerSlots } from "./types.ts";

defineSlots<DialogTriggerSlots>();
</script>

<template>
  <DialogTriggerPart data-slot="dialog-trigger"><slot /></DialogTriggerPart>
</template>
