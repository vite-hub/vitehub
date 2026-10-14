<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const output = `$ pnpm test
\x1b[32m✓\x1b[39m server/utils/format.test.ts \x1b[2m(4 tests)\x1b[22m
\x1b[32m✓\x1b[39m server/utils/parse.test.ts \x1b[2m(7 tests)\x1b[22m
\x1b[31m✗\x1b[39m server/api/chat.test.ts \x1b[2m(3 tests | 1 failed)\x1b[22m

\x1b[31mAssertionError: expected 'hello' to be 'hello world'\x1b[39m

Tests  \x1b[31m1 failed\x1b[39m | \x1b[32m13 passed\x1b[39m (14)`;

// Copy the text without the color escape codes.
const plain = output.replace(/\x1b\[[\d;]*m/g, "");
const lines = useHighlightedCode(output, "ansi");
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-terminal-light" />Terminal</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="plain" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>
        <CodeBlockLine v-for="(line, index) in lines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>
