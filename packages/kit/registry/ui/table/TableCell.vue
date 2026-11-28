<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <td data-slot="table-cell" :class="cn('px-3 py-2 align-middle [&:has([role=checkbox])]:pe-0', props.class)">
    <slot />
  </td>
</template>
