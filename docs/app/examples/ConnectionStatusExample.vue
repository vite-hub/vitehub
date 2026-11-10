<script setup lang="ts">
import type { ConnectionStatusValue } from "@vite-hub/ui";

const status = ref<ConnectionStatusValue>("connecting");
</script>

<template>
  <div class="flex flex-col items-start gap-4">
    <ConnectionStatus :delay="0" :status="status" />
    <div class="flex gap-2">
      <UButton color="neutral" label="Connect" size="xs" variant="outline" @click="status = 'connected'" />
      <UButton color="neutral" label="Drop the connection" size="xs" variant="outline" @click="status = 'disconnected'" />
    </div>
  </div>
</template>
