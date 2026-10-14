<script setup lang="ts">
const error = `$ pnpm install --frozen-lockfile
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with packages/ui/package.json`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <CodeBlock variant="destructive">
      <CodeBlockHeader>
        <CodeBlockTitle>Error</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton :value="error" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap>{{ error }}</CodeBlockContent>
    </CodeBlock>
  </div>
</template>
