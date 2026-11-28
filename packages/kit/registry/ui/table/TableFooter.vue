<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <tfoot data-slot="table-footer" :class="cn('border-t bg-ui-bg-muted font-medium [&>tr]:last:border-b-0', props.class)">
    <slot />
  </tfoot>
</template>
