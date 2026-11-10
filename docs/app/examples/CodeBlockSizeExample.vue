<script setup lang="ts">
const output = `$ pnpm add ai @ai-sdk/vue zod
Progress: resolved 412, reused 398, downloaded 14, added 14, done
Done in 2.8s using pnpm v10.18.0`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-terminal-light" />Terminal</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="output" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>{{ output }}</CodeBlockContent>
    </CodeBlock>
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-terminal-light" />Terminal</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="output" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>{{ output }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
