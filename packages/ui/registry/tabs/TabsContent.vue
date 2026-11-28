<script setup lang="ts">
import { TabsPanel } from "@ui-sdk/vue/tabs";
import type { TabsContentSlots, TabsContentProps } from "./types.ts";
const { value } = defineProps<TabsContentProps>();
defineSlots<TabsContentSlots>();
</script>

<template>
  <TabsPanel :value="value">
    <!-- The ui-sdk part writes its own data-slot. The render slot keeps the item's name on the element. -->
    <template #render="{ props: part, children }">
      <div v-bind="part" data-slot="tabs-content"><component :is="children" /></div>
    </template>
    <slot />
  </TabsPanel>
</template>
