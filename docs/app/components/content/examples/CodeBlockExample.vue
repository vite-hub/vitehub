<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const code = `import { streamText } from "ai";

export default defineEventHandler(async (event) => {
  const { messages } = await readBody(event);

  const result = streamText({
    model: "anthropic/claude-sonnet-4.5",
    system: "You are a helpful assistant. Answer in one short paragraph.",
    messages,
  });

  return result.toUIMessageStreamResponse();
});`;

const wrap = ref(false);
const lines = useHighlightedCode(code, "ts");

function download(value: string, filename: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="flex w-full max-w-lg flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-file-code-light" />server/api/chat.post.ts</CodeBlockTitle>
        <CodeBlockActions>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            square
            icon="i-ph-text-align-left-light"
            aria-label="Wrap lines"
            :aria-pressed="wrap"
            class="aria-pressed:text-highlighted"
            @click="wrap = !wrap"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            square
            icon="i-ph-download-simple-light"
            aria-label="Download"
            @click="download(code, 'chat.post.ts')"
          />
          <CodeBlockCopyButton :value="code" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent :wrap="wrap" line-numbers>
        <CodeBlockLine
          v-for="(line, index) in lines"
          :key="index"
          :variant="index >= 5 && index <= 9 ? 'highlighted' : 'default'"
        >
          <component :is="line" />
        </CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>
