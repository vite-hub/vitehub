<script setup lang="ts">
import { DialogTitle as DialogTitlePart } from "@ui-sdk/vue/dialog";
import type { DialogTitleSlots } from "./types.ts";

defineSlots<DialogTitleSlots>();
</script>

<template>
  <DialogTitlePart data-slot="dialog-title"><slot /></DialogTitlePart>
</template>
