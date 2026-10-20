<script setup lang="ts">
const code = `{
  "name": "chat",
  "private": true,
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build"
  }
}`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockContent line-numbers>{{ code }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
