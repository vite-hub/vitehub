<script setup lang="ts">
import { TabsIndicator, TabsList as TabsListPart } from "@ui-sdk/vue/tabs";
import type { TabsListSlots } from "./types.ts";

defineSlots<TabsListSlots>();
</script>

<template>
  <TabsListPart data-slot="tabs-list">
    <slot />
    <TabsIndicator data-slot="tabs-indicator" />
  </TabsListPart>
</template>
