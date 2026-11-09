<script setup lang="ts">
const command = "pnpm add ai @ai-sdk/vue zod";

const output = `$ ${command}
Packages: +14
Progress: resolved 412, reused 398, downloaded 14, added 14, done
Done in 2.8s using pnpm v10.18.0`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-terminal-light" />Terminal</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="command" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>{{ output }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
