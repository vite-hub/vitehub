<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Label as LabelPart } from "@ui-sdk/vue/label";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <LabelPart :class="cn('flex items-center gap-2 text-sm leading-none font-medium select-none data-disabled:opacity-50 peer-disabled:opacity-50', props.class)">
    <slot />
  </LabelPart>
</template>
