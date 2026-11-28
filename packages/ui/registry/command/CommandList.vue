<script setup lang="ts">
import { CommandList as CommandListPart } from "@ui-sdk/vue/command";
import type { CommandListSlots } from "./types.ts";

defineSlots<CommandListSlots>();
</script>

<template>
  <CommandListPart data-slot="command-list"><slot /></CommandListPart>
</template>
