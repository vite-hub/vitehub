<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { MenuSeparator as MenuSeparatorPart } from "@ui-sdk/vue/menu";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <MenuSeparatorPart :class="cn('-mx-1 my-1 h-px bg-border', props.class)" />
</template>
