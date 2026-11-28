<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { DialogTitle as DialogTitlePart } from "@ui-sdk/vue/dialog";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <DialogTitlePart :class="cn('m-0 text-base leading-tight font-semibold', props.class)">
    <slot />
  </DialogTitlePart>
</template>
