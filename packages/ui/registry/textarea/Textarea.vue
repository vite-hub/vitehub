<script setup lang="ts">
import "../core/vitehub.css";
import "./textarea.css";
import { Textarea as TextareaPart } from "@ui-sdk/vue/textarea";
import type { TextareaProps } from "./types.ts";

const model = defineModel<string>();
const { defaultValue, invalid = false, disabled = false } = defineProps<TextareaProps>();
</script>

<template>
  <TextareaPart
    v-model="model"
    data-slot="textarea"
    :default-value="defaultValue"
    :disabled="disabled || undefined"
    v-bind="invalid ? { 'aria-invalid': 'true', 'data-invalid': '' } : {}"
  />
</template>
