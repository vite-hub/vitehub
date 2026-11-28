<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { DrawerDescription as DrawerDescriptionPart } from "@ui-sdk/vue/drawer";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <DrawerDescriptionPart :class="cn('m-0 text-sm text-muted-foreground', props.class)">
    <slot />
  </DrawerDescriptionPart>
</template>
