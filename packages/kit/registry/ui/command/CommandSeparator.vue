<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { CommandSeparator as CommandSeparatorPart } from "@ui-sdk/vue/command";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <CommandSeparatorPart :class="cn('-mx-1 my-1 h-px bg-border', props.class)" />
</template>
