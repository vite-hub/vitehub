<script setup lang="ts">
import { Tabs, TabsList, TabsPanel, TabsTab } from "@vite-hub/kit/tabs";

const tabs = ["Files", "Terminal", "Preview"];
</script>

<template>
  <button type="button">Before</button>
  <Tabs default-value="Files">
    <TabsList aria-label="Surfaces">
      <TabsTab v-for="tab in tabs" :key="tab" :value="tab">{{ tab }}</TabsTab>
    </TabsList>
    <TabsPanel v-for="tab in tabs" :key="tab" :value="tab">{{ tab }} panel</TabsPanel>
  </Tabs>
  <button type="button">After</button>
</template>
