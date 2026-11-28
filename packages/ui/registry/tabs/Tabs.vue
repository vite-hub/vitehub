<script setup lang="ts">
import "../core/vitehub.css";
import "./tabs.css";
import { Tabs as TabsRoot } from "@ui-sdk/vue/tabs";
import type { TabsEmits, TabsProps, TabsSlots } from "./types.ts";

const model = defineModel<string>();
const { defaultValue, orientation = "horizontal" } = defineProps<TabsProps>();
defineEmits<TabsEmits>();
defineSlots<TabsSlots>();
</script>

<template>
  <TabsRoot v-model:value="model" data-slot="tabs" :default-value="defaultValue" :orientation="orientation"><slot /></TabsRoot>
</template>
