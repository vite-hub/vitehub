<script setup lang="ts">
import { Search } from "@lucide/vue";
import { CommandInput as CommandInputPart } from "@ui-sdk/vue/command";
import type { CommandInputProps, CommandInputSlots } from "./types.ts";

defineOptions({ inheritAttrs: false });
const { label = "Search commands", placeholder = "Type a command or search…" } = defineProps<CommandInputProps>();
defineSlots<CommandInputSlots>();
</script>

<template>
  <div data-slot="command-input-wrapper">
    <slot name="icon"><Search aria-hidden="true" /></slot>
    <CommandInputPart v-bind="$attrs" data-slot="command-input" :aria-label="label" :placeholder="placeholder" />
  </div>
</template>
