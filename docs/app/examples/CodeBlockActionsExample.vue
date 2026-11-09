<script setup lang="ts">
const output = `$ pnpm lint
app/components/MessageList.vue
  18:22  error    'messages' is possibly 'undefined'. Add a guard before you call map  @typescript-eslint/no-unsafe-call
  42:7   warning  'scrollToBottom' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 2 problems (1 error, 1 warning)`;

const wrap = ref(true);

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
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle><UIcon name="i-ph-terminal-light" />Terminal</CodeBlockTitle>
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
            @click="download(output, 'lint.log')"
          />
          <CodeBlockCopyButton :value="output" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent :wrap="wrap">{{ output }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
