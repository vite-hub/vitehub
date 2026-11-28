<script setup lang="ts">
import "../core/vitehub.css";
import "./field.css";
import { Field as FieldPart } from "@ui-sdk/vue/field";
import type { FieldProps, FieldSlots } from "./types.ts";

const { invalid = false, disabled = false } = defineProps<FieldProps>();
defineSlots<FieldSlots>();
</script>

<template>
  <FieldPart data-slot="field" :invalid="invalid || undefined" :disabled="disabled || undefined"><slot /></FieldPart>
</template>
