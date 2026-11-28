<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <p data-slot="empty-description" :class="cn('text-sm text-muted-foreground [&>a]:underline [&>a]:underline-offset-4', props.class)">
    <slot />
  </p>
</template>
