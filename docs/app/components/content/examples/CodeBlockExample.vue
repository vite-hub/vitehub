<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const code = `export default defineEventHandler(async (event) => {
  const { city } = getQuery(event);
  return await getWeather(String(city));
});`;

const lines = useHighlightedCode(code, "ts");
</script>

<template>
  <CodeBlock class="max-w-lg">
    <CodeBlockHeader>
      <CodeBlockTitle><UIcon name="i-ph-file-ts-light" />server/api/weather.ts</CodeBlockTitle>
      <CodeBlockActions>
        <CodeBlockCopyButton :value="code" />
      </CodeBlockActions>
    </CodeBlockHeader>
    <CodeBlockContent line-numbers>
      <CodeBlockLine v-for="(line, index) in lines" :key="index">
        <component :is="line" />
      </CodeBlockLine>
    </CodeBlockContent>
  </CodeBlock>
</template>
