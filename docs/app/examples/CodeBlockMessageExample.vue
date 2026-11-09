<script setup lang="ts">
import { useHighlightedCode } from "@vite-hub/ui";

const code = `import { streamText } from "ai";

export default defineEventHandler(async (event) => {
  const { messages } = await readBody(event);

  const result = streamText({
    model: "anthropic/claude-sonnet-4.5",
    messages,
  });

  return result.toUIMessageStreamResponse();
});`;

const lines = useHighlightedCode(code, "ts");
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4 text-sm">
    <Message align="end">
      <MessageContent>
        <Bubble variant="muted">
          <BubbleContent>How do I stream a response from a Nitro route?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageContent class="gap-3">
        <p>Create a server route that returns the stream:</p>
        <CodeBlock>
          <CodeBlockHeader>
            <CodeBlockTitle>server/api/chat.post.ts</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton :value="code" />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent>
            <CodeBlockLine v-for="(line, index) in lines" :key="index">
              <component :is="line" />
            </CodeBlockLine>
          </CodeBlockContent>
        </CodeBlock>
        <p>The client reads it with the Chat class from @ai-sdk/vue.</p>
      </MessageContent>
    </Message>
  </div>
</template>
