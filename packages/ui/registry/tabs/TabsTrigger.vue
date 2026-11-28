<script setup lang="ts">
import { TabsTab } from "@ui-sdk/vue/tabs";
import type { TabsTriggerSlots, TabsTriggerProps } from "./types.ts";
const { value, disabled = false } = defineProps<TabsTriggerProps>();
defineSlots<TabsTriggerSlots>();
</script>

<template>
  <TabsTab :value="value" :disabled="disabled || undefined">
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <button v-bind="part" data-slot="tabs-trigger"><component :is="children" /></button>
    </template>
    <slot />
  </TabsTab>
</template>
