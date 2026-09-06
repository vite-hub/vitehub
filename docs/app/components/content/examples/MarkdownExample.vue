<script setup lang="ts">
const answer = `## Verification

- **10 tests** passed
- The production page returned \`200\`

The error row now reserves its full height.`;
</script>

<template>
  <AgentMarkdown :value="answer" />
</template>
