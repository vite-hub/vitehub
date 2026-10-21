<script setup lang="ts">
import type { CodeBlockLineVariant } from "@vite-hub/ui";

const patch = ` <template>
-  <p>Hello, {{ name }}</p>
+  <p class="text-sm text-muted">
+    Hello, {{ name }}!
+  </p>
 </template>`;

function getVariant(line: string): CodeBlockLineVariant {
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "default";
}
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>app/components/Greeting.vue</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="patch" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        <CodeBlockLine v-for="(line, index) in patch.split('\n')" :key="index" :variant="getVariant(line)">{{ line.slice(1) }}</CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>
