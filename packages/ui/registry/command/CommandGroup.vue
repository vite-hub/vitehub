<script setup lang="ts">
import { CommandGroup as CommandGroupPart, CommandGroupLabel } from "@ui-sdk/vue/command";
import type { CommandGroupProps, CommandGroupSlots } from "./types.ts";

const { heading } = defineProps<CommandGroupProps>();
defineSlots<CommandGroupSlots>();
</script>

<template>
  <CommandGroupPart data-slot="command-group">
    <CommandGroupLabel v-if="heading" data-slot="command-group-label">{{ heading }}</CommandGroupLabel>
    <slot />
  </CommandGroupPart>
</template>
