<script setup lang="ts">
const answer = String.raw`The p95 latency is the value below which $95\%$ of requests fall.

$$
p_{95} = x_{\lceil 0.95 n \rceil}
$$

With $n = 200$ samples, use the 190th sorted value.`;
</script>

<template>
  <AgentMarkdown :value="answer" />
</template>
