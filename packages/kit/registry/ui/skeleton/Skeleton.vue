<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div data-slot="skeleton" aria-hidden="true" :class="cn('animate-pulse rounded-md bg-ui-bg-accented motion-reduce:animate-none', props.class)" />
</template>
