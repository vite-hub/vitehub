<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <th data-slot="table-head" :class="cn('h-9 px-3 text-start align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pe-0', props.class)">
    <slot />
  </th>
</template>
