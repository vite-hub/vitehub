<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const css = `@import "tailwindcss";
@import "@nuxt/ui";

:root {
  --ui-radius: 0.375rem;
}`;

const python = `def greet(name: str) -> str:
    return f"Hello, {name}!"`;

const text = "A language that is not in the list renders as plain text.";

const cssLines = useHighlightedCode(css, "css");
const pythonLines = useHighlightedCode(python, "python");
const textLines = useHighlightedCode(text, "text");
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>app/assets/css/main.css</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <CodeBlockLine v-for="(line, index) in cssLines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>main.py</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <CodeBlockLine v-for="(line, index) in pythonLines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>notes.txt</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <CodeBlockLine v-for="(line, index) in textLines" :key="index">
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>
