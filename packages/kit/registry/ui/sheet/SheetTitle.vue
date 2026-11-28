<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { DrawerTitle as DrawerTitlePart } from "@ui-sdk/vue/drawer";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <DrawerTitlePart :class="cn('m-0 text-base leading-tight font-semibold', props.class)">
    <slot />
  </DrawerTitlePart>
</template>
