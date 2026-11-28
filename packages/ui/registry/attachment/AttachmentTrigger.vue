<script setup lang="ts">
import { computed, useAttrs, useSlots } from "vue";
import type { AttachmentTriggerSlots } from "./types.ts";

// The trigger covers the whole attachment, so a click on any part of it opens the file. Give it an accessible name.
defineOptions({ inheritAttrs: false });
defineSlots<AttachmentTriggerSlots>();
const attrs = useAttrs();
const slots = useSlots();
// An attachment group scrolls sideways and clips a ring outside the card, so the focus ring goes inside.
const part = computed(() => ({ ...attrs, "data-focus-inset": "", "data-slot": "attachment-trigger" }));
const children = () => slots.default?.();
</script>

<template>
  <slot name="render" :props="part" :children="children">
    <button type="button" v-bind="part"><slot /></button>
  </slot>
</template>
