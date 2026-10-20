<script setup lang="ts">
const logs = Array.from(
  { length: 40 },
  (_, index) => `[${String(index + 1).padStart(2, "0")}] POST /api/chat 200 in ${12 + ((index * 7) % 40)}ms`,
).join("\n");
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>Logs</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="logs" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent class="max-h-48">{{ logs }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
