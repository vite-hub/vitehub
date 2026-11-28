<script setup lang="ts">
import "../core/vitehub.css";
import "./label.css";
import { Label as LabelPart } from "@ui-sdk/vue/label";
import type { LabelProps, LabelSlots } from "./types.ts";

const { label } = defineProps<LabelProps>();
defineSlots<LabelSlots>();
</script>

<template>
  <LabelPart data-slot="label"><slot>{{ label }}</slot></LabelPart>
</template>
