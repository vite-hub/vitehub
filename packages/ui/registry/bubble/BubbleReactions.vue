<script setup lang="ts">
import type { BubbleReactionsProps, BubbleReactionsSlots } from "./types.ts";

const { align = "end", side = "bottom" } = defineProps<BubbleReactionsProps>();
defineSlots<BubbleReactionsSlots>();
</script>

<template>
  <div data-slot="bubble-reactions" :data-align="align" :data-side="side"><slot /></div>
</template>
