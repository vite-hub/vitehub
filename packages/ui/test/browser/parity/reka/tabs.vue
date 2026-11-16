<script setup lang="ts">
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";

const tabs = ["Files", "Terminal", "Preview"];
</script>

<template>
  <button type="button">Before</button>
  <TabsRoot default-value="Files">
    <TabsList aria-label="Surfaces">
      <TabsTrigger v-for="tab in tabs" :key="tab" :value="tab">{{ tab }}</TabsTrigger>
    </TabsList>
    <TabsContent v-for="tab in tabs" :key="tab" :value="tab">{{ tab }} panel</TabsContent>
  </TabsRoot>
  <button type="button">After</button>
</template>
