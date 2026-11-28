<script setup lang="ts">
import { CommandItem as CommandItemPart } from "@ui-sdk/vue/command";
import type { CommandItemProps, CommandItemSlots } from "./types.ts";

const { value, disabled = false, shortcut } = defineProps<CommandItemProps>();
defineSlots<CommandItemSlots>();
</script>

<template>
  <CommandItemPart data-slot="command-item" :value="value" :disabled="disabled || undefined" :shortcut="shortcut"><slot /></CommandItemPart>
</template>
