<script setup lang="ts">
import "../core/vitehub.css";
import "./button.css";
import { LoaderCircle } from "@lucide/vue";
import { Button as ButtonPart } from "@ui-sdk/vue/button";
import type { ButtonProps, ButtonSlots } from "./types.ts";

const { variant = "outline", size = "md", type = "button", label, loading = false, disabled = false } = defineProps<ButtonProps>();
defineSlots<ButtonSlots>();
</script>

<template>
  <ButtonPart
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :data-loading="loading ? '' : undefined"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
  >
    <LoaderCircle v-if="loading" data-slot="button-spinner" aria-hidden="true" />
    <slot v-else name="icon" />
    <slot>{{ label }}</slot>
  </ButtonPart>
</template>
