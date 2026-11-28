<script setup lang="ts">
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs/index.ts";
</script>

<template>
  <div data-slot="example-tabs" style="display: flex; flex-direction: column; gap: 0.75rem; max-width: 24rem">
    <Tabs default-value="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="deploys">Deploys</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">The project runs on Cloudflare.</TabsContent>
      <TabsContent value="deploys">12 deploys this week.</TabsContent>
      <TabsContent value="settings">Change the name and the region.</TabsContent>
    </Tabs>
  </div>
</template>
