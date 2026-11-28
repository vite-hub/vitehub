<script setup lang="ts">
import "../core/vitehub.css";
import "./input.css";
import { Input as InputPart } from "@ui-sdk/vue/input";
import type { InputProps } from "./types.ts";

const model = defineModel<string>();
const { defaultValue, size = "md", invalid = false, disabled = false } = defineProps<InputProps>();
</script>

<template>
  <InputPart
    v-model="model"
    data-slot="input"
    :data-size="size"
    :default-value="defaultValue"
    :disabled="disabled || undefined"
    v-bind="invalid ? { 'aria-invalid': 'true', 'data-invalid': '' } : {}"
  />
</template>
