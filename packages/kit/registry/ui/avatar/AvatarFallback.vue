<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { AvatarFallback as AvatarFallbackPart } from "@ui-sdk/vue/avatar";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <AvatarFallbackPart :class="cn('flex size-full items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground', props.class)">
    <slot />
  </AvatarFallbackPart>
</template>
