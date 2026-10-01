<script setup lang="ts">
const chart =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#f4f4f5"/><path d="M40 280 L180 200 L320 220 L460 110 L600 70" stroke="#18181b" stroke-width="6" fill="none"/></svg>',
  );

const answer = `Latency dropped after the cache change.

![Request latency over the last hour](${chart})

> Select the thumbnail to open the full image. Press Escape to close it.`;
</script>

<template>
  <AgentMarkdown :value="answer" />
</template>
