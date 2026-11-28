<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(defineProps<{ colspan?: number; class?: HTMLAttributes["class"] }>(), { colspan: 1 });
</script>

<template>
  <tr data-slot="table-empty">
    <td :colspan="props.colspan" :class="cn('px-3 py-10 text-center text-sm text-muted-foreground', props.class)">
      <slot />
    </td>
  </tr>
</template>
