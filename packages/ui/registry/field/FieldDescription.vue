<script setup lang="ts">
import { FieldDescription as FieldDescriptionPart } from "@ui-sdk/vue/field";
import type { FieldDescriptionSlots } from "./types.ts";

defineSlots<FieldDescriptionSlots>();
</script>

<template>
  <FieldDescriptionPart data-slot="field-description"><slot /></FieldDescriptionPart>
</template>
