<script setup lang="ts">
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "@vite-hub/kit/progress"
</script>

<template>
  <Progress :value="60">
    <ProgressLabel>Exporting video</ProgressLabel>
    <ProgressValue />
    <ProgressTrack>
      <ProgressIndicator />
    </ProgressTrack>
  </Progress>
</template>
