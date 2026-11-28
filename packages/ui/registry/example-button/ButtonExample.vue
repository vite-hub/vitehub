<script setup lang="ts">
import { Button } from "../button/index.ts";
import { Plus } from "@lucide/vue";
</script>

<template>
  <div data-slot="example-button" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Button variant="solid" label="Deploy" />
    <Button label="Cancel" />
    <Button variant="soft" label="Preview" />
    <Button variant="ghost" label="Skip" />
    <Button variant="link" label="Learn more" />
    <Button variant="destructive" label="Delete" />
    <Button size="sm" label="Small">
      <template #icon><Plus aria-hidden="true" /></template>
    </Button>
    <Button aria-label="Add project" size="sm"><Plus aria-hidden="true" /></Button>
    <Button variant="solid" label="Saving" loading />
  </div>
</template>
