<script setup lang="ts">
import type { DeviceFrameSize } from "@vite-hub/ui";

const size = ref<DeviceFrameSize>({ on: true, id: "iphone", width: 393, height: 852, zoom: null });
</script>

<template>
  <div class="flex h-[32rem] flex-col">
    <DeviceFrame v-model="size">
      <div class="flex h-full flex-col gap-3 p-6">
        <p class="text-sm font-medium text-highlighted">
          {{ size.width }} × {{ size.height }}
        </p>
        <p class="text-sm text-muted">
          This page gets exactly that many CSS pixels, so its media queries see the device.
        </p>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="item in 6" :key="item" class="h-16 rounded-md bg-elevated" />
        </div>
      </div>
    </DeviceFrame>
    <UButton
      v-if="!size.on"
      class="m-3 self-start"
      color="neutral"
      label="Device mode"
      size="xs"
      variant="outline"
      @click="size = { ...size, on: true }"
    />
  </div>
</template>
