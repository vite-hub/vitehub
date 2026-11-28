<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <tr data-slot="table-row" :class="cn('border-b transition-colors hover:bg-accent data-[state=selected]:bg-ui-bg-accented', props.class)">
    <slot />
  </tr>
</template>
