<script setup lang="ts">
import { FieldError as FieldErrorPart } from "@ui-sdk/vue/field";
import type { FieldErrorSlots } from "./types.ts";

defineSlots<FieldErrorSlots>();
</script>

<template>
  <FieldErrorPart data-slot="field-error"><slot /></FieldErrorPart>
</template>
