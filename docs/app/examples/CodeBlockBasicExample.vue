<script setup lang="ts">
const output = `$ pnpm build
> nuxt build

✔ Client built in 3412ms
✔ Server built in 1876ms
✔ Nuxt Nitro server built
  ├─ .output/server/chunks/routes/api/chat.post.mjs (2.1 kB)
  └─ .output/server/index.mjs (4.6 kB)
Σ Total size: 1.42 MB (412 kB gzip)`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock>
      <CodeBlockContent>{{ output }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
