<script setup lang="ts">
import { CommandEmpty as CommandEmptyPart } from "@ui-sdk/vue/command";
import type { CommandEmptyProps, CommandEmptySlots } from "./types.ts";

const { label = "No results found." } = defineProps<CommandEmptyProps>();
defineSlots<CommandEmptySlots>();
</script>

<template>
  <CommandEmptyPart data-slot="command-empty"><slot>{{ label }}</slot></CommandEmptyPart>
</template>
