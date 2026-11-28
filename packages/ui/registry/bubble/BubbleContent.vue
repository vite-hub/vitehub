<script setup lang="ts">
import { computed, useAttrs, useSlots } from "vue";
import type { BubbleContentSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
defineSlots<BubbleContentSlots>();
const attrs = useAttrs();
const slots = useSlots();
const part = computed(() => ({ ...attrs, "data-slot": "bubble-content" }));
const children = () => slots.default?.();
</script>

<template>
  <slot name="render" :props="part" :children="children">
    <div v-bind="part"><slot /></div>
  </slot>
</template>
