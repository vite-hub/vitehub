<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Avatar as AvatarPart } from "@ui-sdk/vue/avatar";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <AvatarPart :class="cn('relative flex size-8 shrink-0 overflow-hidden rounded-full bg-muted', props.class)">
    <slot />
  </AvatarPart>
</template>
