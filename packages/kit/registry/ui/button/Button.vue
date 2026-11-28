<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Button as ButtonPart } from "@ui-sdk/vue/button";
import { cn } from "@/lib/utils";
import { buttonVariants } from ".";
import type { ButtonSize, ButtonVariant } from ".";

const props = defineProps<{ variant?: ButtonVariant; size?: ButtonSize; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <ButtonPart :data-variant="props.variant ?? 'default'" :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)">
    <slot />
  </ButtonPart>
</template>
