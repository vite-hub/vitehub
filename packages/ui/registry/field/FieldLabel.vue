<script setup lang="ts">
import { FieldLabel as FieldLabelPart } from "@ui-sdk/vue/field";
import type { FieldLabelProps, FieldLabelSlots } from "./types.ts";

const { label } = defineProps<FieldLabelProps>();
defineSlots<FieldLabelSlots>();
</script>

<template>
  <FieldLabelPart data-slot="field-label"><slot>{{ label }}</slot></FieldLabelPart>
</template>
