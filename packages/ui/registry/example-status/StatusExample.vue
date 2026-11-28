<script setup lang="ts">
import { Status } from "../status/index.ts";
</script>

<template>
  <div data-slot="example-status" style="display: flex; flex-direction: column; gap: 0.5rem">
    <Status label="Idle" />
    <Status tone="success" label="Deployed" />
    <Status tone="warning" label="Building" pulse />
    <Status tone="error" label="Failed" colored />
    <Status tone="info" label="Queued" size="md" />
    <Status tone="success" />
  </div>
</template>
