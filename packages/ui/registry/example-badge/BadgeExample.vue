<script setup lang="ts">
import { Badge } from "../badge/index.ts";
</script>

<template>
  <div data-slot="example-badge" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem">
    <Badge label="Draft" />
    <Badge tone="success" label="Live" />
    <Badge tone="warning" variant="outline" label="Pending" />
    <Badge tone="error" variant="solid" label="Failed" />
    <Badge tone="info" size="sm" label="Beta" />
  </div>
</template>
