<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <hr data-slot="sidebar-separator" :class="cn('mx-2 my-0 border-0 border-t border-sidebar-border', props.class)">
</template>
