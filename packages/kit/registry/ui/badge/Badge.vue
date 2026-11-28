<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { badgeVariants } from ".";
import type { BadgeVariant } from ".";

const props = defineProps<{ variant?: BadgeVariant; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <span data-slot="badge" :data-variant="props.variant ?? 'default'" :class="cn(badgeVariants({ variant: props.variant }), props.class)">
    <slot />
  </span>
</template>
