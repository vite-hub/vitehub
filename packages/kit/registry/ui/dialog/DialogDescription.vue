<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { DialogDescription as DialogDescriptionPart } from "@ui-sdk/vue/dialog";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <DialogDescriptionPart :class="cn('m-0 text-sm text-muted-foreground', props.class)">
    <slot />
  </DialogDescriptionPart>
</template>
