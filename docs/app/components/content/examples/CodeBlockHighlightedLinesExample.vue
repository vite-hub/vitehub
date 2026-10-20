<script setup lang="ts">
const code = `export default defineNuxtConfig({
  experimental: {
    viewTransition: true,
    typedPages: true,
  },
  image: {
    domains: ["avatars.githubusercontent.com"],
  },
});`;

const highlighted = [2, 3];
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockContent line-numbers>
        <CodeBlockLine
          v-for="(line, index) in code.split('\n')"
          :key="index"
          :variant="highlighted.includes(index) ? 'highlighted' : 'default'"
        >{{ line }}</CodeBlockLine>
      </CodeBlockContent>
    </CodeBlock>
  </div>
</template>
