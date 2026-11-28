<script setup lang="ts">
import "../core/vitehub.css";
import "./command.css";
import { Command as CommandRoot } from "@ui-sdk/vue/command";
import type { CommandEmits, CommandProps, CommandSlots } from "./types.ts";

const query = defineModel<string>("query");
const { defaultQuery } = defineProps<CommandProps>();
const emit = defineEmits<CommandEmits>();
defineSlots<CommandSlots>();
</script>

<template>
  <CommandRoot v-model:query="query" data-slot="command" :default-query="defaultQuery" @action="(value: string) => emit('action', { value })"><slot /></CommandRoot>
</template>
